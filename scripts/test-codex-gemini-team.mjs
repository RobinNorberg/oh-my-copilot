#!/usr/bin/env node
/**
 * Live test: spawn a 2-worker tmux team with Codex + Gemini CLI workers.
 * Must be run inside tmux. Panes will appear in the current window.
 * Usage: node scripts/test-codex-gemini-team.mjs
 */
import { startTeam, monitorTeam, shutdownTeam } from '../dist/team/runtime.js';

const CWD = process.cwd();

const config = {
  teamName: 'cgtest',
  workerCount: 2,
  agentTypes: ['codex', 'gemini'],
  tasks: [
    {
      subject: 'Write a haiku about tmux split panes',
      description: [
        'Write a haiku (3 lines, 5-7-5 syllables) about tmux split panes.',
        'Save the haiku to the file: ' + CWD + '/done.json',
        'The file should be valid JSON: {"taskId":"1","status":"completed","summary":"<your haiku here>","completedAt":"' + new Date().toISOString() + '"}',
        'Write the file and exit.',
      ].join(' '),
    },
    {
      subject: 'Write a haiku about AI collaboration',
      description: [
        'Write a haiku (3 lines, 5-7-5 syllables) about AI models collaborating.',
        'Save the haiku to the file: ' + CWD + '/farewell.txt',
        'The file should contain just the haiku text.',
        'Write the file and exit.',
      ].join(' '),
    },
  ],
  cwd: CWD,
};

console.log('\n🚀 Starting tmux team "cgtest" with Codex + Gemini workers...\n');

const runtime = await startTeam(config);

console.log('✅ Team started!');
console.log(`   tmux target  : ${runtime.sessionName}`);
console.log(`   workers      : ${runtime.workerNames.join(', ')}`);
console.log(`   pane IDs     : ${runtime.workerPaneIds.join(', ')}`);
console.log('\n⏳ Monitoring... (polling every 5s, timeout 120s)\n');

const deadline = Date.now() + 120_000;
let done = false;

while (Date.now() < deadline && !done) {
  await new Promise(r => setTimeout(r, 5000));
  const snap = await monitorTeam(runtime.teamName, runtime.cwd, runtime.workerPaneIds);
  const { pending, inProgress, completed, failed } = snap.taskCounts;
  console.log(`   [${new Date().toLocaleTimeString()}] phase=${snap.phase}  pending=${pending} inProgress=${inProgress} completed=${completed} failed=${failed}`);
  snap.deadWorkers.forEach(w => console.log(`   ⚠️  dead worker: ${w}`));
  if (snap.phase === 'completed' || snap.phase === 'failed') {
    done = true;
  }
}

if (!done) {
  console.log('\n⚠️  Timeout — shutting down anyway\n');
}

console.log('\n🛑 Shutting down team...');
await shutdownTeam(runtime.teamName, runtime.sessionName, runtime.cwd, 15_000, runtime.workerPaneIds, runtime.leaderPaneId);
console.log('✅ Team shut down cleanly.\n');

// Show results
import { readFileSync, existsSync } from 'fs';
if (existsSync(CWD + '/done.json')) {
  const d = JSON.parse(readFileSync(CWD + '/done.json', 'utf-8'));
  console.log('📄 Codex result (done.json):', d.summary || d);
}
if (existsSync(CWD + '/farewell.txt')) {
  console.log('📄 Gemini result (farewell.txt):\n' + readFileSync(CWD + '/farewell.txt', 'utf-8'));
}
