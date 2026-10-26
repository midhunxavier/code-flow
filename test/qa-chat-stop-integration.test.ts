import test from 'node:test';
import assert from 'node:assert/strict';
import { taskTeamControl, taskTeamRoute } from '../src/task-team.js';
test('the chat history replay distinguishes explicit stops from mixed corrections',()=>{
 assert.equal(taskTeamControl('Stop the team and wait.'),'stop');
 assert.equal(taskTeamControl('Stop. Also keep the README unchanged'),undefined);
 assert.equal(taskTeamRoute('Stop. Also keep the README unchanged',true),'team');
});
