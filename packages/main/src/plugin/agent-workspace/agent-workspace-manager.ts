/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Disposable, FileSystemWatcher, RunError } from '@openkaiden/api';
import type { WebContents } from 'electron';
import { inject, injectable, preDestroy } from 'inversify';

import { IPCHandle, WebContentsType } from '/@/plugin/api.js';
import { CliToolRegistry } from '/@/plugin/cli-tool-registry.js';
import { FilesystemMonitoring } from '/@/plugin/filesystem-monitoring.js';
import { TaskManager } from '/@/plugin/tasks/task-manager.js';
import { Exec } from '/@/plugin/util/exec.js';
import type {
  AgentWorkspaceConfiguration,
  AgentWorkspaceCreateOptions,
  AgentWorkspaceId,
  AgentWorkspaceSummary,
} from '/@api/agent-workspace-info.js';
import { ApiSenderType } from '/@api/api-sender/api-sender-type.js';

/**
 * Manages agent workspaces by delegating to the `kdn` CLI.
 */
@injectable()
export class AgentWorkspaceManager implements Disposable {
  private instancesWatcher: FileSystemWatcher | undefined;
  private readonly terminalCallbacks = new Map<
    number,
    { write: (param: string) => void; resize: (w: number, h: number) => void }
  >();
  private readonly terminalProcesses = new Map<number, ChildProcessWithoutNullStreams>();

  constructor(
    @inject(ApiSenderType)
    private readonly apiSender: ApiSenderType,
    @inject(IPCHandle)
    private readonly ipcHandle: IPCHandle,
    @inject(Exec)
    private readonly exec: Exec,
    @inject(CliToolRegistry)
    private readonly cliToolRegistry: CliToolRegistry,
    @inject(TaskManager)
    private readonly taskManager: TaskManager,
    @inject(FilesystemMonitoring)
    private readonly filesystemMonitoring: FilesystemMonitoring,
    @inject(WebContentsType)
    private readonly webContents: WebContents,
  ) {}

  private getCliPath(): string {
    const tool = this.cliToolRegistry.getCliToolInfos().find(t => t.name === 'kdn');
    if (tool?.path) {
      return tool.path;
    }
    return 'kdn';
  }

  /**
   * Extract a meaningful error message from a kdn CLI failure.
   *
   * When invoked with `--output json`, kdn writes structured errors to stdout
   * as `{"error":"..."}`. This method parses that when available, otherwise
   * falls back to the generic error message.
   */
  private extractCliError(err: unknown): string {
    if (err instanceof Error && 'stdout' in err && typeof (err as RunError).stdout === 'string') {
      try {
        const parsed: unknown = JSON.parse((err as RunError).stdout);
        if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
          const errorField = (parsed as { error: unknown }).error;
          if (typeof errorField === 'string' && errorField) {
            return errorField;
          }
        }
      } catch {
        // not JSON – fall through
      }
    }
    return err instanceof Error ? err.message : String(err);
  }

  private async execKdn<T>(args: string[], options?: { cwd?: string }): Promise<T> {
    const cliPath = this.getCliPath();
    const fullArgs = ['workspace', ...args, '--output', 'json'];
    console.log(`Executing: ${cliPath} ${fullArgs.join(' ')}`);
    try {
      const result = await this.exec.exec(cliPath, fullArgs, options);
      return JSON.parse(result.stdout) as T;
    } catch (err: unknown) {
      const detail = this.extractCliError(err);
      console.error(`kdn failed: ${cliPath} ${fullArgs.join(' ')} — ${detail}`);
      throw new Error(detail);
    }
  }

  async create(options: AgentWorkspaceCreateOptions): Promise<AgentWorkspaceId> {
    const cliPath = this.getCliPath();
    const runtime = options.runtime ?? 'podman';
    const args = ['init', options.sourcePath, '--runtime', runtime, '--agent', options.agent, '--output', 'json'];
    if (options.name) {
      args.push('--name', options.name);
    }
    if (options.project) {
      args.push('--project', options.project);
    }
    const suffix = options.name ? ` "${options.name}"` : '';
    const task = this.taskManager.createTask({ title: `Creating workspace${suffix}` });
    task.state = 'running';
    task.status = 'in-progress';
    console.log(`Executing: ${cliPath} ${args.join(' ')}`);
    try {
      const result = await this.exec.exec(cliPath, args);
      const workspaceId = JSON.parse(result.stdout) as AgentWorkspaceId;
      this.apiSender.send('agent-workspace-update');
      task.status = 'success';
      return workspaceId;
    } catch (err: unknown) {
      const detail = this.extractCliError(err);
      console.error(`kdn failed: ${cliPath} ${args.join(' ')} — ${detail}`);
      task.status = 'failure';
      task.error = `Failed to create workspace: ${detail}`;
      throw new Error(detail);
    } finally {
      task.state = 'completed';
    }
  }

  async list(): Promise<AgentWorkspaceSummary[]> {
    const response = await this.execKdn<{ items: AgentWorkspaceSummary[] }>(['list']);
    return response.items;
  }

  async remove(id: string): Promise<AgentWorkspaceId> {
    const result = await this.execKdn<AgentWorkspaceId>(['remove', id]);
    this.apiSender.send('agent-workspace-update');
    return result;
  }

  async getConfiguration(id: string): Promise<AgentWorkspaceConfiguration> {
    const workspaces = await this.list();
    const workspace = workspaces.find(ws => ws.id === id);
    if (!workspace) {
      throw new Error(`workspace "${id}" not found. Use "workspace list" to see available workspaces.`);
    }
    try {
      const content = await readFile(join(workspace.paths.configuration, 'workspace.json'), 'utf-8');
      return JSON.parse(content) as AgentWorkspaceConfiguration;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {} as AgentWorkspaceConfiguration;
      }
      throw error;
    }
  }

  async start(id: string): Promise<AgentWorkspaceId> {
    const result = await this.execKdn<AgentWorkspaceId>(['start', id]);
    this.apiSender.send('agent-workspace-update');
    return result;
  }

  async stop(id: string): Promise<AgentWorkspaceId> {
    const result = await this.execKdn<AgentWorkspaceId>(['stop', id]);
    this.apiSender.send('agent-workspace-update');
    return result;
  }

  shellInAgentWorkspace(
    name: string,
    onData: (data: string) => void,
    onError: (error: string) => void,
    onEnd: () => void,
  ): {
    write: (param: string) => void;
    resize: (w: number, h: number) => void;
    process: ChildProcessWithoutNullStreams;
  } {
    // eslint-disable-next-line sonarjs/no-os-command-from-path
    const childProcess = spawn('kdn', ['terminal', name]);

    childProcess.stdout.on('data', (chunk: Buffer) => {
      onData(chunk.toString('utf-8'));
    });

    childProcess.stderr.on('data', (chunk: Buffer) => {
      onData(chunk.toString('utf-8'));
    });

    childProcess.on('error', (error: Error) => {
      onError(error.message);
    });

    childProcess.on('close', () => {
      onEnd();
    });

    return {
      write: (param: string): void => {
        childProcess.stdin.write(param);
      },
      resize: (_w: number, _h: number): void => {
        // no-op: resize requires a PTY (e.g. node-pty); can be added later
      },
      process: childProcess,
    };
  }

  init(): void {
    this.ipcHandle(
      'agent-workspace:create',
      async (_listener: unknown, options: AgentWorkspaceCreateOptions): Promise<AgentWorkspaceId> => {
        return this.create(options);
      },
    );

    this.ipcHandle('agent-workspace:list', async (): Promise<AgentWorkspaceSummary[]> => {
      return this.list();
    });

    this.ipcHandle('agent-workspace:remove', async (_listener: unknown, id: string): Promise<AgentWorkspaceId> => {
      return this.remove(id);
    });

    this.ipcHandle(
      'agent-workspace:getConfiguration',
      async (_listener: unknown, id: string): Promise<AgentWorkspaceConfiguration> => {
        return this.getConfiguration(id);
      },
    );

    this.ipcHandle('agent-workspace:start', async (_listener: unknown, id: string): Promise<AgentWorkspaceId> => {
      return this.start(id);
    });

    this.ipcHandle('agent-workspace:stop', async (_listener: unknown, id: string): Promise<AgentWorkspaceId> => {
      return this.stop(id);
    });

    this.ipcHandle(
      'agent-workspace:terminal',
      async (_listener: unknown, id: string, onDataId: number): Promise<number> => {
        const workspaces = await this.list();
        const workspace = workspaces.find(ws => ws.id === id);
        if (!workspace) {
          throw new Error(`workspace "${id}" not found. Use "workspace list" to see available workspaces.`);
        }
        const invocation = this.shellInAgentWorkspace(
          workspace.name,
          (content: string) => {
            this.webContents.send('agent-workspace:terminal-onData', onDataId, content);
          },
          (error: string) => {
            this.webContents.send('agent-workspace:terminal-onError', onDataId, error);
          },
          () => {
            this.webContents.send('agent-workspace:terminal-onEnd', onDataId);
            this.terminalCallbacks.delete(onDataId);
            this.terminalProcesses.delete(onDataId);
          },
        );
        this.terminalCallbacks.set(onDataId, { write: invocation.write, resize: invocation.resize });
        this.terminalProcesses.set(onDataId, invocation.process);
        return onDataId;
      },
    );

    this.ipcHandle(
      'agent-workspace:terminalSend',
      async (_listener: unknown, onDataId: number, content: string): Promise<void> => {
        const callback = this.terminalCallbacks.get(onDataId);
        if (callback) {
          callback.write(content);
        }
      },
    );

    this.ipcHandle(
      'agent-workspace:terminalResize',
      async (_listener: unknown, onDataId: number, width: number, height: number): Promise<void> => {
        const callback = this.terminalCallbacks.get(onDataId);
        if (callback) {
          callback.resize(width, height);
        }
      },
    );

    this.watchInstancesFile();
  }

  private watchInstancesFile(): void {
    this.instancesWatcher?.dispose();
    const instancesPath = join(homedir(), '.kdn', 'instances.json');
    this.instancesWatcher = this.filesystemMonitoring.createFileSystemWatcher(instancesPath);
    const notify = (): void => {
      this.apiSender.send('agent-workspace-update');
    };
    this.instancesWatcher.onDidChange(notify);
    this.instancesWatcher.onDidCreate(notify);
    this.instancesWatcher.onDidDelete(notify);
  }

  @preDestroy()
  dispose(): void {
    this.instancesWatcher?.dispose();
    for (const proc of this.terminalProcesses.values()) {
      if (!proc.killed) {
        proc.kill();
      }
    }
    this.terminalProcesses.clear();
    this.terminalCallbacks.clear();
  }
}
