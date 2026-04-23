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

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FileSystemWatcher, RunError, RunResult } from '@openkaiden/api';
import type { WebContents } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { IPCHandle } from '/@/plugin/api.js';
import type { CliToolRegistry } from '/@/plugin/cli-tool-registry.js';
import type { FilesystemMonitoring } from '/@/plugin/filesystem-monitoring.js';
import type { Proxy as ProxyType } from '/@/plugin/proxy.js';
import type { TaskManager } from '/@/plugin/tasks/task-manager.js';
import type { Task } from '/@/plugin/tasks/tasks.js';
import { Exec } from '/@/plugin/util/exec.js';
import type { AgentWorkspaceCreateOptions, AgentWorkspaceSummary } from '/@api/agent-workspace-info.js';
import type { ApiSenderType } from '/@api/api-sender/api-sender-type.js';
import type { CliToolInfo } from '/@api/cli-tool-info.js';
import type { TaskState, TaskStatus } from '/@api/taskInfo.js';

import { AgentWorkspaceManager } from './agent-workspace-manager.js';

vi.mock(import('node:fs/promises'));
vi.mock(import('yaml'));
vi.mock(import('node:child_process'));

const TEST_SUMMARIES: AgentWorkspaceSummary[] = [
  {
    id: 'ws-1',
    name: 'test-workspace-1',
    project: 'project-alpha',
    agent: 'coder-v1',
    state: 'stopped',
    model: 'gpt-4o',
    paths: { source: '/tmp/ws1', configuration: '/tmp/ws1/.kaiden' },
  },
  {
    id: 'ws-2',
    name: 'test-workspace-2',
    project: 'project-beta',
    agent: 'coder-v2',
    state: 'running',
    paths: { source: '/tmp/ws2', configuration: '/tmp/ws2/.kaiden' },
  },
];

let manager: AgentWorkspaceManager;

const apiSender: ApiSenderType = {
  send: vi.fn(),
  receive: vi.fn(),
};
const ipcHandle: IPCHandle = vi.fn();
const proxy = {
  isEnabled: vi.fn().mockReturnValue(false),
} as unknown as ProxyType;
const exec = new Exec(proxy);
const cliToolRegistry = {
  getCliToolInfos: vi.fn().mockReturnValue([{ name: 'kdn', path: '/usr/local/bin/kdn' }]),
} as unknown as CliToolRegistry;

const mockTask = {
  id: 'task-1',
  name: 'mock-task',
  started: Date.now(),
  state: '',
  status: '',
  error: '',
  cancellable: false,
  dispose: vi.fn(),
  onUpdate: vi.fn(),
} as unknown as Task;
const taskManager = {
  createTask: vi.fn().mockReturnValue(mockTask),
} as unknown as TaskManager;

const mockWatcher = {
  onDidChange: vi.fn(),
  onDidCreate: vi.fn(),
  onDidDelete: vi.fn(),
  dispose: vi.fn(),
} as unknown as FileSystemWatcher;
const filesystemMonitoring = {
  createFileSystemWatcher: vi.fn().mockReturnValue(mockWatcher),
} as unknown as FilesystemMonitoring;

const KAIDEN_CLI_PATH = '/usr/local/bin/kdn';

const webContents = {
  send: vi.fn(),
  receive: vi.fn(),
} as unknown as WebContents;
function mockExecResult(stdout: string): RunResult {
  return { command: KAIDEN_CLI_PATH, stdout, stderr: '' };
}

function mockRunError(overrides: Partial<RunError> = {}): RunError {
  const err = new Error(overrides.message ?? 'Command execution failed with exit code 1') as RunError;
  err.exitCode = overrides.exitCode ?? 1;
  err.command = overrides.command ?? KAIDEN_CLI_PATH;
  err.stdout = overrides.stdout ?? '';
  err.stderr = overrides.stderr ?? '';
  err.cancelled = overrides.cancelled ?? false;
  err.killed = overrides.killed ?? false;
  return err;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(cliToolRegistry.getCliToolInfos).mockReturnValue([
    { name: 'kdn', path: KAIDEN_CLI_PATH },
  ] as unknown as CliToolInfo[]);
  vi.mocked(taskManager.createTask).mockReturnValue(mockTask);
  mockTask.state = '' as TaskState;
  mockTask.status = '' as TaskStatus;
  mockTask.error = '';
  vi.mocked(filesystemMonitoring.createFileSystemWatcher).mockReturnValue(mockWatcher);
  manager = new AgentWorkspaceManager(
    apiSender,
    ipcHandle,
    exec,
    cliToolRegistry,
    taskManager,
    filesystemMonitoring,
    webContents,
  );
  manager.init();
});

describe('init', () => {
  test('registers IPC handler for create', () => {
    expect(ipcHandle).toHaveBeenCalledWith('agent-workspace:create', expect.any(Function));
  });

  test('registers IPC handler for list', () => {
    expect(ipcHandle).toHaveBeenCalledWith('agent-workspace:list', expect.any(Function));
  });

  test('registers IPC handler for remove', () => {
    expect(ipcHandle).toHaveBeenCalledWith('agent-workspace:remove', expect.any(Function));
  });

  test('registers IPC handler for getConfiguration', () => {
    expect(ipcHandle).toHaveBeenCalledWith('agent-workspace:getConfiguration', expect.any(Function));
  });

  test('registers IPC handler for start', () => {
    expect(ipcHandle).toHaveBeenCalledWith('agent-workspace:start', expect.any(Function));
  });

  test('registers IPC handler for stop', () => {
    expect(ipcHandle).toHaveBeenCalledWith('agent-workspace:stop', expect.any(Function));
  });
});

describe('watchInstancesFile', () => {
  test('watches ~/.kdn/instances.json on init', () => {
    expect(filesystemMonitoring.createFileSystemWatcher).toHaveBeenCalledWith(
      expect.stringMatching(/\.kdn[\\/]instances\.json$/),
    );
  });

  test('sends agent-workspace-update on file change', () => {
    const changeCallback = vi.mocked(mockWatcher.onDidChange).mock.calls[0]![0] as () => void;
    changeCallback();
    expect(apiSender.send).toHaveBeenCalledWith('agent-workspace-update');
  });

  test('sends agent-workspace-update on file create', () => {
    const createCallback = vi.mocked(mockWatcher.onDidCreate).mock.calls[0]![0] as () => void;
    createCallback();
    expect(apiSender.send).toHaveBeenCalledWith('agent-workspace-update');
  });

  test('sends agent-workspace-update on file delete', () => {
    const deleteCallback = vi.mocked(mockWatcher.onDidDelete).mock.calls[0]![0] as () => void;
    deleteCallback();
    expect(apiSender.send).toHaveBeenCalledWith('agent-workspace-update');
  });

  test('disposes watcher on dispose', () => {
    manager.dispose();
    expect(mockWatcher.dispose).toHaveBeenCalled();
  });
});

describe('getCliPath', () => {
  test('falls back to kdn when no CLI tool is registered', async () => {
    vi.mocked(cliToolRegistry.getCliToolInfos).mockReturnValue([]);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ items: [] })));

    await manager.list();

    expect(exec.exec).toHaveBeenCalledWith('kdn', ['workspace', 'list', '--output', 'json'], undefined);
  });
});

describe('create', () => {
  const defaultOptions: AgentWorkspaceCreateOptions = {
    sourcePath: '/tmp/my-project',
    agent: 'claude',
    runtime: 'podman',
  };

  test('executes kdn init with required flags and returns the workspace id', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-new' })));

    const result = await manager.create(defaultOptions);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Executing:'));
    expect(exec.exec).toHaveBeenCalledWith(KAIDEN_CLI_PATH, [
      'init',
      '/tmp/my-project',
      '--runtime',
      'podman',
      '--agent',
      'claude',
      '--output',
      'json',
    ]);
    expect(result).toEqual({ id: 'ws-new' });
  });

  test('creates a task and sets success status on completion', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-new' })));

    await manager.create(defaultOptions);

    expect(taskManager.createTask).toHaveBeenCalledWith({ title: 'Creating workspace' });
    expect(mockTask.status).toBe('success');
    expect(mockTask.state).toBe('completed');
  });

  test('sets task failure status when CLI fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockRejectedValue(new Error('command not found'));

    await expect(manager.create(defaultOptions)).rejects.toThrow('command not found');

    expect(mockTask.status).toBe('failure');
    expect(mockTask.error).toContain('command not found');
    expect(mockTask.state).toBe('completed');
  });

  test('extracts kdn JSON error from stdout on failure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runError = mockRunError({
      stdout: JSON.stringify({ error: 'failed to create runtime instance: exit status 125' }),
    });
    vi.spyOn(exec, 'exec').mockRejectedValue(runError);

    await expect(manager.create(defaultOptions)).rejects.toThrow('failed to create runtime instance: exit status 125');

    expect(mockTask.error).toBe('Failed to create workspace: failed to create runtime instance: exit status 125');
  });

  test('includes workspace name in task title when provided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-new' })));

    await manager.create({ ...defaultOptions, name: 'my-workspace' });

    expect(taskManager.createTask).toHaveBeenCalledWith({ title: 'Creating workspace "my-workspace"' });
  });

  test('defaults runtime to podman when not specified', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-new' })));

    await manager.create({ sourcePath: '/tmp/my-project', agent: 'claude' });

    expect(exec.exec).toHaveBeenCalledWith(KAIDEN_CLI_PATH, expect.arrayContaining(['--runtime', 'podman']));
  });

  test('includes optional name flag when provided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-new' })));

    await manager.create({ ...defaultOptions, name: 'my-workspace' });

    expect(exec.exec).toHaveBeenCalledWith(KAIDEN_CLI_PATH, expect.arrayContaining(['--name', 'my-workspace']));
  });

  test('includes optional project flag when provided', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-new' })));

    await manager.create({ ...defaultOptions, project: 'my-project' });

    expect(exec.exec).toHaveBeenCalledWith(KAIDEN_CLI_PATH, expect.arrayContaining(['--project', 'my-project']));
  });

  test('emits agent-workspace-update event', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-new' })));

    await manager.create(defaultOptions);

    expect(apiSender.send).toHaveBeenCalledWith('agent-workspace-update');
  });

  test('rejects when source directory does not exist', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockRejectedValue(new Error('sources directory does not exist: /tmp/not-found'));

    await expect(manager.create({ ...defaultOptions, sourcePath: '/tmp/not-found' })).rejects.toThrow(
      'sources directory does not exist: /tmp/not-found',
    );
  });
});

describe('list', () => {
  test('executes kdn workspace list and returns items', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ items: TEST_SUMMARIES })));

    const result = await manager.list();

    expect(exec.exec).toHaveBeenCalledWith(KAIDEN_CLI_PATH, ['workspace', 'list', '--output', 'json'], undefined);
    expect(result).toHaveLength(2);
    expect(result.map(s => s.id)).toEqual(['ws-1', 'ws-2']);
  });

  test('returns summaries with expected CLI fields', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ items: TEST_SUMMARIES })));

    const summary = (await manager.list())[0]!;

    expect(summary).toHaveProperty('id');
    expect(summary).toHaveProperty('name');
    expect(summary).toHaveProperty('project');
    expect(summary).toHaveProperty('agent');
    expect(summary).toHaveProperty('state');
    expect(summary).toHaveProperty('model');
    expect(summary).toHaveProperty('paths');
    expect(summary.paths).toHaveProperty('source');
    expect(summary.paths).toHaveProperty('configuration');
  });

  test('returns summaries without model when CLI omits it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ items: TEST_SUMMARIES })));

    const summary = (await manager.list())[1]!;

    expect(summary.model).toBeUndefined();
  });

  test('rejects when CLI fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockRejectedValue(new Error('command not found'));

    await expect(manager.list()).rejects.toThrow('command not found');
  });
});

describe('remove', () => {
  test('executes kdn workspace remove and returns the workspace id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-1' })));

    const result = await manager.remove('ws-1');

    expect(exec.exec).toHaveBeenCalledWith(
      KAIDEN_CLI_PATH,
      ['workspace', 'remove', 'ws-1', '--output', 'json'],
      undefined,
    );
    expect(result).toEqual({ id: 'ws-1' });
  });

  test('emits agent-workspace-update event', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-1' })));

    await manager.remove('ws-1');

    expect(apiSender.send).toHaveBeenCalledWith('agent-workspace-update');
  });

  test('rejects when CLI fails for unknown id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockRejectedValue(new Error('workspace not found: unknown-id'));

    await expect(manager.remove('unknown-id')).rejects.toThrow('workspace not found: unknown-id');
  });
});

describe('getConfiguration', () => {
  test('reads JSON configuration file from workspace directory', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ items: TEST_SUMMARIES })));
    vi.mocked(readFile).mockResolvedValue('{"mounts":{"dependencies":[]}}');

    const result = await manager.getConfiguration('ws-1');

    expect(exec.exec).toHaveBeenCalledWith(KAIDEN_CLI_PATH, ['workspace', 'list', '--output', 'json'], undefined);
    expect(readFile).toHaveBeenCalledWith(join('/tmp/ws1/.kaiden', 'workspace.json'), 'utf-8');
    expect(result).toEqual({ mounts: { dependencies: [] } });
  });

  test('throws when workspace id is not found in list', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ items: TEST_SUMMARIES })));

    await expect(manager.getConfiguration('unknown-id')).rejects.toThrow(
      'workspace "unknown-id" not found. Use "workspace list" to see available workspaces.',
    );
  });

  test('returns empty configuration when file does not exist', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ items: TEST_SUMMARIES })));
    const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    vi.mocked(readFile).mockRejectedValue(enoent);

    const result = await manager.getConfiguration('ws-1');

    expect(result).toEqual({});
  });

  test('rejects when reading the configuration file fails with a non-ENOENT error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ items: TEST_SUMMARIES })));
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    vi.mocked(readFile).mockRejectedValue(eacces);

    await expect(manager.getConfiguration('ws-1')).rejects.toThrow('EACCES: permission denied');
  });
});

describe('start', () => {
  test('executes kdn workspace start and returns the workspace id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-1' })));

    const result = await manager.start('ws-1');

    expect(exec.exec).toHaveBeenCalledWith(
      KAIDEN_CLI_PATH,
      ['workspace', 'start', 'ws-1', '--output', 'json'],
      undefined,
    );
    expect(result).toEqual({ id: 'ws-1' });
  });

  test('emits agent-workspace-update event', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-1' })));

    await manager.start('ws-1');

    expect(apiSender.send).toHaveBeenCalledWith('agent-workspace-update');
  });

  test('rejects when CLI fails for unknown id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockRejectedValue(new Error('workspace not found: unknown-id'));

    await expect(manager.start('unknown-id')).rejects.toThrow('workspace not found: unknown-id');
  });
});

describe('stop', () => {
  test('executes kdn workspace stop and returns the workspace id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-1' })));

    const result = await manager.stop('ws-1');

    expect(exec.exec).toHaveBeenCalledWith(
      KAIDEN_CLI_PATH,
      ['workspace', 'stop', 'ws-1', '--output', 'json'],
      undefined,
    );
    expect(result).toEqual({ id: 'ws-1' });
  });

  test('emits agent-workspace-update event', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ id: 'ws-1' })));

    await manager.stop('ws-1');

    expect(apiSender.send).toHaveBeenCalledWith('agent-workspace-update');
  });

  test('rejects when CLI fails for unknown id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(exec, 'exec').mockRejectedValue(new Error('workspace not found: unknown-id'));

    await expect(manager.stop('unknown-id')).rejects.toThrow('workspace not found: unknown-id');
  });
});

describe('shellInAgentWorkspace', () => {
  function createMockProcess(overrides?: {
    stdoutOn?: ReturnType<typeof vi.fn>;
    stderrOn?: ReturnType<typeof vi.fn>;
    processOn?: ReturnType<typeof vi.fn>;
  }): ChildProcessWithoutNullStreams {
    return {
      stdout: { on: overrides?.stdoutOn ?? vi.fn() },
      stderr: { on: overrides?.stderrOn ?? vi.fn() },
      stdin: { write: vi.fn() },
      on: overrides?.processOn ?? vi.fn(),
      killed: false,
      kill: vi.fn(),
    } as unknown as ChildProcessWithoutNullStreams;
  }

  test('returns write and resize functions', () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess());

    const result = manager.shellInAgentWorkspace('test-workspace-1', vi.fn(), vi.fn(), vi.fn());

    expect(result).toHaveProperty('write');
    expect(result).toHaveProperty('resize');
    expect(result).toHaveProperty('process');
  });

  test('spawns kdn terminal with workspace name', () => {
    vi.mocked(spawn).mockReturnValue(createMockProcess());

    manager.shellInAgentWorkspace('test-workspace-1', vi.fn(), vi.fn(), vi.fn());

    expect(spawn).toHaveBeenCalledWith('kdn', ['terminal', 'test-workspace-1']);
  });

  test('write function forwards data to stdin', () => {
    const mockProcess = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProcess);

    const result = manager.shellInAgentWorkspace('test-workspace-1', vi.fn(), vi.fn(), vi.fn());
    result.write('hello');

    expect(mockProcess.stdin.write).toHaveBeenCalledWith('hello');
  });

  test('calls onData when stdout emits data', () => {
    const stdoutListeners = new Map<string, (data: Buffer) => void>();
    const mockProcess = createMockProcess({
      stdoutOn: vi.fn((event: string, cb: (data: Buffer) => void) => stdoutListeners.set(event, cb)),
    });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    const onData = vi.fn();
    manager.shellInAgentWorkspace('test-workspace-1', onData, vi.fn(), vi.fn());

    const dataCallback = stdoutListeners.get('data');
    expect(dataCallback).toBeDefined();
    dataCallback!(Buffer.from('output'));

    expect(onData).toHaveBeenCalledWith('output');
  });

  test('calls onEnd when process closes', () => {
    const processListeners = new Map<string, () => void>();
    const mockProcess = createMockProcess({
      processOn: vi.fn((event: string, cb: () => void) => processListeners.set(event, cb)),
    });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    const onEnd = vi.fn();
    manager.shellInAgentWorkspace('test-workspace-1', vi.fn(), vi.fn(), onEnd);

    const closeCallback = processListeners.get('close');
    expect(closeCallback).toBeDefined();
    closeCallback!();

    expect(onEnd).toHaveBeenCalled();
  });

  test('calls onError when process emits error', () => {
    const processListeners = new Map<string, (err: Error) => void>();
    const mockProcess = createMockProcess({
      processOn: vi.fn((event: string, cb: (err: Error) => void) => processListeners.set(event, cb)),
    });
    vi.mocked(spawn).mockReturnValue(mockProcess);

    const onError = vi.fn();
    manager.shellInAgentWorkspace('test-workspace-1', vi.fn(), onError, vi.fn());

    const errorCallback = processListeners.get('error');
    expect(errorCallback).toBeDefined();
    errorCallback!(new Error('spawn failed'));

    expect(onError).toHaveBeenCalledWith('spawn failed');
  });
});

describe('dispose', () => {
  test('kills active terminal processes', async () => {
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ items: TEST_SUMMARIES })));

    const mockProcess = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      stdin: { write: vi.fn() },
      on: vi.fn(),
      killed: false,
      kill: vi.fn(),
    } as unknown as ChildProcessWithoutNullStreams;
    vi.mocked(spawn).mockReturnValue(mockProcess);

    const terminalHandler = vi
      .mocked(ipcHandle)
      .mock.calls.find(call => call[0] === 'agent-workspace:terminal')?.[1] as (
      _listener: unknown,
      id: string,
      onDataId: number,
    ) => Promise<number>;
    expect(terminalHandler).toBeDefined();

    await terminalHandler({}, 'ws-1', 1);

    manager.dispose();

    expect(mockProcess.kill).toHaveBeenCalled();
  });

  test('terminal IPC handler rejects when workspace id is not found', async () => {
    vi.spyOn(exec, 'exec').mockResolvedValue(mockExecResult(JSON.stringify({ items: TEST_SUMMARIES })));

    const terminalHandler = vi
      .mocked(ipcHandle)
      .mock.calls.find(call => call[0] === 'agent-workspace:terminal')?.[1] as (
      _listener: unknown,
      id: string,
      onDataId: number,
    ) => Promise<number>;
    expect(terminalHandler).toBeDefined();

    await expect(terminalHandler({}, 'unknown-id', 1)).rejects.toThrow(
      'workspace "unknown-id" not found. Use "workspace list" to see available workspaces.',
    );
  });
});
