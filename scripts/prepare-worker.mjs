import { mkdir, writeFile } from 'node:fs/promises';
import { buildWorkerLaunch } from '../src/isolation.mjs';

// Reviewable candidate only: does not run WSL or create any account.
const candidate = buildWorkerLaunch({ distribution: 'Ubuntu-24.04', projectPath: '/home/codexlink/projects/acceptance', workerHome: '/home/codexlink/worker-state/acceptance' });
const { env, ...plan } = candidate;
plan.environmentKeys = Object.keys(env);
plan.installCommand = 'wsl.exe --install --distribution Ubuntu-24.04 --no-launch';
plan.installEffect = 'Enable required Windows virtualization/WSL components and download Ubuntu; administrator elevation and a manual reboot may be required.';
plan.codexPackageCandidate = '@openai/codex@0.155.1';
plan.credentials = 'Not copied or provisioned. Authentication and native desktop discovery remain acceptance requirements.';
await mkdir('.runtime', { recursive: true });
await writeFile('.runtime/worker-plan.json', JSON.stringify(plan, null, 2));
console.log(JSON.stringify({ written: '.runtime/worker-plan.json', installed: false, releaseReady: false, pending: plan.pending }, null, 2));
