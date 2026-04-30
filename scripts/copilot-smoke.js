#!/usr/bin/env node

const assert = require('assert');
const { CopilotMemory } = require('../dist-electron/electron/copilot/CopilotMemory');
const { LectureStrategy } = require('../dist-electron/electron/copilot/LectureStrategy');

const baseTime = 1_700_000_000_000;

class FakeLectureQuestionGenerator {
  constructor(question) {
    this.question = question;
  }

  async generateLectureQuestion() {
    return {
      question: this.question,
      confidence: 0.88,
      topic: 'gradient descent',
      suggestionType: 'course_clarification',
      reason: 'The point was completed and the question is grounded.',
    };
  }
}

async function run() {
  await testMemoryBuildsRollingContext();
  await testLectureStrategyWaitsForIncompletePoint();
  await testLectureStrategyAsksWhenGrounded();
  await testLectureStrategyRejectsUngroundedQuestion();
  console.log('[copilot-smoke] all tests passed');
}

async function testMemoryBuildsRollingContext() {
  const memory = new CopilotMemory();
  memory.addSegment(segment(0, 'Gradient descent updates parameters using the slope of the loss function.'));
  memory.addSegment(segment(1, 'A smaller learning rate makes the optimization more stable.'));

  const snapshot = memory.getSnapshot('lecture');
  assert.equal(snapshot.segments.length, 2);
  assert.match(snapshot.rollingText, /Gradient descent/);
  assert.ok(snapshot.structuredSummary.keyTerms.includes('gradient'));
}

async function testLectureStrategyWaitsForIncompletePoint() {
  const memory = new CopilotMemory();
  for (let i = 0; i < 4; i += 1) {
    memory.addSegment(segment(i, `Gradient descent uses local slope information to update parameters because ${i}`));
  }

  const strategy = new LectureStrategy(new FakeLectureQuestionGenerator('How does gradient descent use the loss slope?'));
  const decision = await strategy.decide(memory.getSnapshot('lecture'));
  assert.equal(decision.action, 'WAIT');
}

async function testLectureStrategyAsksWhenGrounded() {
  const memory = new CopilotMemory();
  [
    'Gradient descent is an optimization method that updates model parameters using the slope of the loss function.',
    'When the learning rate is small, each gradient descent step is more stable but training can become slower.',
    'When the learning rate is large, the method can move faster but may overshoot the minimum of the loss.',
    'Therefore, choosing the learning rate is a tradeoff between stability and convergence speed.',
  ].forEach((text, index) => memory.addSegment(segment(index, text)));

  const strategy = new LectureStrategy(new FakeLectureQuestionGenerator('How does the learning rate affect gradient descent stability?'));
  const decision = await strategy.decide(memory.getSnapshot('lecture'));
  assert.equal(decision.action, 'ASK');
  assert.match(decision.suggestion || '', /learning rate/i);
}

async function testLectureStrategyRejectsUngroundedQuestion() {
  const memory = new CopilotMemory();
  [
    'Gradient descent is an optimization method that updates model parameters using the slope of the loss function.',
    'A small learning rate makes each update more stable while slowing the optimization process.',
    'A large learning rate can overshoot the minimum and make the training process unstable.',
    'Therefore, the learning rate controls the tradeoff between stability and convergence speed.',
  ].forEach((text, index) => memory.addSegment(segment(index, text)));

  const strategy = new LectureStrategy(new FakeLectureQuestionGenerator('How does quantum tunneling affect enzyme catalysis?'));
  const decision = await strategy.decide(memory.getSnapshot('lecture'));
  assert.equal(decision.action, 'WAIT');
}

function segment(index, text) {
  return {
    id: `seg_${index}`,
    speaker: 'interviewer',
    text,
    timestamp: baseTime + index * 16_000,
    final: true,
    confidence: 0.95,
  };
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
