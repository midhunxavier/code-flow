import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunNavigation } from '../ui/keyboard-navigation.js';
test('keyboard traversal keeps the original unread order as opened rows move to recent', () => {
  const nav = new RunNavigation();
  assert.equal(nav.next(['c', 'b', 'a'], undefined, 'status', 1), 'c');
  assert.equal(nav.next(['b', 'a', 'c'], 'c', 'status', 1), 'b');
  assert.equal(nav.next(['a', 'c', 'b'], 'b', 'status', 1), 'a');
  assert.equal(nav.next(['c', 'b', 'a'], 'a', 'status', -1), 'b');
  assert.equal(nav.next(['c', 'b', 'a'], 'b', 'status', -1), 'c');
  assert.equal(nav.next(['c', 'b', 'a'], 'c', 'status', -1), 'c');
});
test('manual selection, a changed filter or grouping and leaving the view start a fresh sequence', () => {
  const nav = new RunNavigation();
  nav.next(['c', 'b', 'a'], undefined, 'status', 1);
  assert.equal(nav.next(['b', 'c', 'a'], 'a', 'status', -1), 'c', 'manual navigation uses current order');
  assert.equal(nav.next(['a', 'b', 'c'], 'c', 'project', -1), 'b', 'changed grouping resets order');
  assert.equal(nav.next(['a'], 'b', 'filtered', 1), 'a', 'changed filter cannot open hidden rows');
  nav.reset();
  assert.equal(nav.next(['new', 'a'], undefined, 'filtered', 1), 'new');
});
test('deleted rows are skipped and newly arriving runs do not disrupt an active traversal', () => {
  const nav = new RunNavigation();
  assert.equal(nav.next(['c', 'b', 'a'], undefined, 'all', 1), 'c');
  assert.equal(nav.next(['new', 'a', 'c'], 'c', 'all', 1), 'a');
  assert.equal(nav.next(['new', 'a', 'c'], 'a', 'all', -1), 'c');
});
