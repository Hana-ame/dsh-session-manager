// Workspace-scoping test for the Session Canvas client half.
//
// The helpers under test live inside the browser bundle (a classic script, not a
// module), so they are sliced out of the source by their markers and evaluated
// here. This keeps the test against the shipped file instead of a copy: if a
// marker moves, the test fails loudly rather than silently passing on stale code.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

const START = '/** Whether `cwd` names `root` itself';
const END = 'const drawScene = (canvas';
const start = source.indexOf(START);
const end = source.indexOf(END);
if (start < 0 || end < 0 || end < start) throw new Error('scope.test: the helper markers moved in lib/client.js');

const { underRoot, workspaceOf, scopeToWorkspace } = new Function(
  source.slice(start, end) + '\nreturn { underRoot, workspaceOf, scopeToWorkspace };',
)();

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left === right) passed += 1;
  else {
    failed += 1;
    console.log(`FAIL ${label}\n  actual   ${left}\n  expected ${right}`);
  }
};

/** One normalized canvas record. */
const s = (id, cwd, parentId = null) => ({ id, cwd, parentId });
const A = { workspaceId: 'wA', path: '/tmp/a', title: 'A', sessionIds: ['s1', 's2'] };
const B = { workspaceId: 'wB', path: '/tmp/b', title: 'B', sessionIds: ['s3'] };
const items = [A, B];
const ids = (rows) => rows.map((row) => row.id);

// Resolving the Workspace that accounts for a session.
check('workspace by membership', workspaceOf(items, 's1', [])?.workspaceId, 'wA');
check('workspace of another row', workspaceOf(items, 's3', [])?.workspaceId, 'wB');
check('workspace via ancestor chain', workspaceOf(items, 's9', [s('s9', '/tmp/a', 's1')])?.workspaceId, 'wA');
check('workspace unknown session', workspaceOf(items, 'zz', []), null);
check('workspace without rows', workspaceOf(null, 's1', []), null);
check('workspace without current', workspaceOf(items, null, []), null);

// Restricting the graph to one Workspace.
const all = [
  s('s1', '/tmp/a'),
  s('s2', '/tmp/a/sub'),
  s('s4', '/tmp/a'),
  s('s5', '/tmp/ab'),
  s('s3', '/tmp/b'),
  s('s6', '/elsewhere', 's1'),
  s('s7', '/tmp/ab/deep', 's5'),
  s('s8', null, 's2'),
];
check('scope to A', ids(scopeToWorkspace(all, A, 's1')), ['s1', 's2', 's4', 's6', 's8']);
check('scope to B', ids(scopeToWorkspace(all, B, 's3')), ['s3']);
check('sibling prefix is not a match', ids(scopeToWorkspace(all, A, 's1')).includes('s5'), false);
check('child of an excluded session stays out', ids(scopeToWorkspace(all, A, 's1')).includes('s7'), false);
check('cwd fallback without a workspace row', ids(scopeToWorkspace(all, null, 's3')), ['s3']);
check('no signal draws nothing', scopeToWorkspace(all, null, null), []);
check('unknown current draws nothing', scopeToWorkspace(all, null, 'nope'), []);
check('empty input', scopeToWorkspace([], A, 's1'), []);
check('membership without a path', ids(scopeToWorkspace(all, { workspaceId: 'wC', path: '', sessionIds: ['s5'] }, 's5')), ['s5', 's7']);
check('trailing slash on the root path', ids(scopeToWorkspace(all, { path: '/tmp/a/', sessionIds: [] }, 's1')), ['s1', 's2', 's4', 's6', 's8']);
check('filesystem root', underRoot('/tmp/a', '/'), true);
check('sibling does not start with the root name', underRoot('/tmp/ab', '/tmp/a'), false);

console.log(`${failed === 0 ? 'ALL PASS' : 'FAILURES'}: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
