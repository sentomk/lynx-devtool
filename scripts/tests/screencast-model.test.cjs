const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the real model with only its browser/CDP dependencies replaced.
function harness() {
  const calls = [];
  const agent = {
    invoke_startScreencast: async params => {
      calls.push(['start', params]);
      return {getError: () => undefined};
    },
    invoke_stopScreencast: () => calls.push(['stop']),
    invoke_screencastFrameAck: params => calls.push(['ack', params]),
  };
  const setting = {get: () => '0'};
  const modules = {
    '../common/common.js': {Settings: {Settings: {instance: () => ({
      createSetting: () => ({get: () => 'fullscreen'}), moduleSetting: () => setting,
    })}}},
    './OverlayModel.js': {OverlayModel: {}},
    './Target.js': {Capability: {ScreenCapture: 1}},
    './SDKModel.js': {SDKModel: class { static register() {} }},
    '../protocol_client/InspectorBackend.js': {envLogger: {info() {}, error() {}}},
  };
  const filename = path.resolve(__dirname, '../../packages/devtools-frontend-lynx/front_end/core/sdk/ScreenCaptureModel.ts');
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
  }).outputText;
  const context = {exports: {}, require: name => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, performance, window: {setTimeout}, clearTimeout, console: {error() {}}};
  vm.runInNewContext(js, context, {filename});
  const model = new context.exports.ScreenCaptureModel({pageAgent: () => agent, registerPageDispatcher() {}});
  const start = callback => model.startScreencast('jpeg', 40, 600, 900, undefined, callback, () => {}, undefined, false, true, true);
  const frame = (id, delta = false) => ({data: 'image', sessionId: id, metadata: {
    lynxFrame: {frameId: id, frameType: delta ? 'delta' : 'full'},
  }});
  return {model, calls, start, frame, acks: () => calls.filter(call => call[0] === 'ack')};
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('ACK waits until asynchronous presentation completes', async () => {
  const h = harness();
  let finish;
  h.start(() => new Promise(resolve => { finish = resolve; }));
  h.model.screencastFrame(h.frame(1));
  await flush();
  assert.equal(h.acks().length, 0);
  finish();
  await flush();
  assert.equal(h.acks()[0][1].sessionId, 1);
  assert.equal(h.calls[0][1].enableFrameSignalGate, true);
});

test('stopping suppresses ACK from an outstanding decode', async () => {
  const h = harness();
  let finish;
  h.start(() => new Promise(resolve => { finish = resolve; }));
  h.model.screencastFrame(h.frame(1));
  await flush();
  h.model.stopScreencast();
  finish();
  await flush();
  assert.equal(h.acks().length, 0);
});

test('delta payloads never replace the cached full frame', async () => {
  const h = harness();
  h.start(() => {});
  h.model.screencastFrame(h.frame(1));
  h.model.screencastFrame(h.frame(2, true));
  await flush();
  assert.equal(h.model._cachedScreencastFrame.sessionId, 1);
  assert.deepEqual(h.acks().map(call => call[1].sessionId), [1, 2]);
});

test('a failed consumer does not poison subsequent presentation or ACK', async () => {
  const h = harness();
  let count = 0;
  h.start(() => { if (++count === 1) throw new Error('decode failed'); });
  h.model.screencastFrame(h.frame(1));
  h.model.screencastFrame(h.frame(2));
  await flush();
  assert.deepEqual(h.acks().map(call => call[1].sessionId), [1, 2]);
});

test('paused capture retains ACK until resume', async () => {
  const h = harness();
  h.start(() => {});
  h.model.setScreencastCapturePaused(true);
  h.model.screencastFrame(h.frame(1));
  await flush();
  assert.equal(h.acks().length, 0);
  h.model.setScreencastCapturePaused(false);
  assert.equal(h.acks().length, 1);
});
