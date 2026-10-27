"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test } = require("node:test");
const { DurationTriggers, DEFINITIONS, durationInMillis } = require("../lib/duration-triggers");

const seconds = (duration) => ({ duration, unit: "seconds" });
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

function fixture(config = {}) {
  const cards = new Map();
  const timers = new Set();
  const devices = [];
  const calls = [];
  const errors = [];
  const app = {
    log() {},
    error: (...args) => errors.push(args),
    getPresenceStatus: () => devices.map((device) => ({
      id: device.getData().id, present: device.present, guest: device.guest, kid: device.kid,
    })),
  };
  function card(id, deviceCard) {
    const value = {
      registerRunListener(listener) { this.listener = listener; },
      getArgumentValues: async (device) => {
        if (deviceCard) assert.ok(devices.includes(device));
        else assert.equal(device, undefined);
        const args = config[id] || [];
        return typeof args === "function" ? args(device) : args;
      },
      async trigger(...args) {
        const [device, tokens, state] = deviceCard ? args : [undefined, ...args];
        const values = await this.getArgumentValues(device);
        for (const value of values) {
          if (this.listener(value, JSON.parse(JSON.stringify(state)))) calls.push({ id, device, tokens, value });
        }
      },
    };
    cards.set(id, value);
    return value;
  }
  app.homey = {
    flow: { getTriggerCard: (id) => card(id, false), getDeviceTriggerCard: (id) => card(id, true) },
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
  };
  const manager = new DurationTriggers(app);
  function addDevice({ guest = false, kid = false, present = false } = {}) {
    const id = `device-${devices.length}`;
    const device = {
      present, guest, kid, generation: 0,
      getData: () => ({ id }),
      getFlowCardTokens: () => ({ who: id }),
      getPresenceStatus() { return this.present; },
      isGuest() { return this.guest; },
      isKid() { return this.kid; },
      isHouseHoldMember() { return !this.guest; },
    };
    devices.push(device);
    return device;
  }
  function transition(device, present) {
    const previous = app.getPresenceStatus();
    const generation = ++device.generation;
    manager.transition(device, present, previous, () => device.generation === generation);
    device.present = present;
  }
  async function expire(delay = Infinity) {
    for (const timer of [...timers]) {
      if (timer.delay > delay) continue;
      timers.delete(timer);
      timer.callback();
    }
    await flush();
  }
  return { manager, app, cards, timers, devices, calls, errors, addDevice, transition, expire };
}

for (const group of [
  { name: "member", guest: false, kid: false, category: "household_member" },
  { name: "kid", guest: false, kid: true, category: "kid" },
  { name: "guest", guest: true, kid: false, category: "guest" },
  { name: "guest kid", guest: true, kid: true, category: "kid" },
]) {
  for (const present of [true, false]) {
    test(`${group.name}: duration variants select the same arrival/departure events`, async () => {
      const config = Object.fromEntries(DEFINITIONS.map(({ id }) => [`${id}_for_duration`, [seconds(5)]]));
      const f = fixture(config);
      const device = f.addDevice({ ...group, present: !present });
      f.transition(device, present);
      await flush();
      assert.equal(f.calls.length, 0);
      const expected = [
        present ? "user_entered" : "user_left", present ? "someone_entered" : "someone_left",
        present ? "first_person_entered" : "last_person_left",
      ];
      const categories = [...(!group.guest ? ["household_member"] : []), ...(group.kid ? ["kid"] : []), ...(group.guest ? ["guest"] : [])];
      for (const category of categories) expected.push(
        `${category}_${present ? "arrived" : "left"}`,
        `${present ? "first" : "last"}_${category}_${present ? "arrived" : "left"}`,
      );
      await f.expire();
      assert.deepEqual(f.calls.map(({ id }) => id).sort(), expected.map((id) => `${id}_for_duration`).sort());
      assert.ok(f.calls.every(({ tokens }) => tokens.who === device.getData().id));
      assert.equal(f.manager.pending.size, 0);
      assert.deepEqual(f.errors, []);
      await f.expire();
      assert.equal(f.calls.length, expected.length);
    });
  }
}

test("independent durations, equivalent units, duplicate Flows and device arguments", async () => {
  const f = fixture({ user_entered_for_duration: [seconds(2), seconds(2), seconds(60), { duration: 1, unit: "minutes" }] });
  const device = f.addDevice();
  f.transition(device, true);
  await flush();
  assert.equal(f.timers.size, 2);
  await f.expire(2100);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((call) => call.device === device && call.value.duration === 2));
  await f.expire();
  assert.equal(f.calls.length, 4);
});

test("reversal cancels arrival timers; returning starts a fresh first-person timer", async () => {
  const f = fixture({ first_person_entered_for_duration: [seconds(5)] });
  const device = f.addDevice();
  f.transition(device, true);
  await flush();
  f.transition(device, false);
  await flush();
  await f.expire();
  assert.equal(f.calls.length, 0);
  f.transition(device, true);
  await flush();
  await f.expire();
  assert.equal(f.calls.length, 1);
});

test("first-person timer follows the first person even when another person arrives", async () => {
  const f = fixture({ first_person_entered_for_duration: [seconds(5)] });
  const first = f.addDevice();
  const second = f.addDevice();
  f.transition(first, true);
  f.transition(second, true);
  await flush();
  await f.expire();
  assert.deepEqual(f.calls.map(({ tokens }) => tokens.who), [first.getData().id]);
});

test("another person staying home cannot replace the first person's continuous stay", async () => {
  const f = fixture({ first_person_entered_for_duration: [seconds(5)] });
  const first = f.addDevice();
  const second = f.addDevice();
  f.transition(first, true);
  f.transition(second, true);
  await flush();
  f.transition(first, false);
  await flush();
  await f.expire();
  assert.equal(f.calls.length, 0);
});

test("last-departure timer is cancelled by a peer return, even if the peer leaves again", async () => {
  const f = fixture({ last_person_left_for_duration: [seconds(5)], someone_left_for_duration: [seconds(5)] });
  const first = f.addDevice({ present: true });
  const second = f.addDevice({ present: true });
  f.transition(first, false);
  f.transition(second, false);
  await flush();
  f.transition(first, true);
  f.transition(first, false);
  await flush();
  await f.expire();
  const last = f.calls.filter(({ id }) => id === "last_person_left_for_duration");
  assert.deepEqual(last.map(({ tokens }) => tokens.who), [first.getData().id]);
  assert.equal(f.calls.filter(({ id }) => id === "someone_left_for_duration").length, 2);
});

test("a guest return cancels last-person but preserves last-household-member absence", async () => {
  const f = fixture({ last_person_left_for_duration: [seconds(5)], last_household_member_left_for_duration: [seconds(5)] });
  const member = f.addDevice({ present: true });
  const guest = f.addDevice({ guest: true });
  f.transition(member, false);
  await flush();
  f.transition(guest, true);
  await flush();
  await f.expire();
  assert.deepEqual(f.calls.map(({ id }) => id), ["last_household_member_left_for_duration"]);
});

test("late argument lookup cannot resurrect a reversed transition", async () => {
  let resolve;
  const deferred = new Promise((r) => { resolve = r; });
  const f = fixture({ first_person_entered_for_duration: () => deferred });
  const device = f.addDevice();
  f.transition(device, true);
  f.transition(device, false);
  resolve([seconds(5)]);
  await flush();
  assert.equal(f.timers.size, 0);
  assert.equal(f.manager.pending.size, 0);
});

test("a queued SDK run listener cannot pass after a reversal", async () => {
  const f = fixture({ first_person_entered_for_duration: [seconds(5)] });
  const device = f.addDevice();
  let state;
  let resolve;
  const dispatch = new Promise((r) => { resolve = r; });
  const card = f.cards.get("first_person_entered_for_duration");
  card.trigger = async (tokens, triggerState) => {
    state = JSON.parse(JSON.stringify(triggerState));
    await dispatch;
  };
  f.transition(device, true);
  await flush();
  await f.expire();
  assert.equal(card.listener(seconds(5), state), true);
  f.transition(device, false);
  assert.equal(card.listener(seconds(5), state), false);
  resolve();
  await flush();
  assert.equal(f.manager.dispatches.size, 0);
});

test("cleanup invalidates timers, queued callbacks and pending argument lookups", async () => {
  const f = fixture({ first_person_entered_for_duration: [seconds(5)] });
  f.transition(f.addDevice(), true);
  await flush();
  const [timer] = f.timers;
  f.manager.stop("app stopped");
  timer.callback();
  f.transition(f.addDevice(), true);
  await flush();
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.manager.pending.size, 0);
});

test("lookup and trigger failures are logged with their cause and cleaned up", async () => {
  const cause = new Error("SDK failure");
  const f = fixture({ first_person_entered_for_duration: () => { throw cause; }, someone_entered_for_duration: [seconds(5)] });
  f.cards.get("someone_entered_for_duration").trigger = async () => { throw cause; };
  f.transition(f.addDevice(), true);
  await flush();
  await f.expire();
  assert.equal(f.errors.length, 2);
  assert.ok(f.errors.every((args) => args[1] === cause));
  assert.equal(f.manager.pending.size, 0);
});

test("invalid and overflowing durations are rejected", () => {
  for (const args of [seconds(0), seconds(0.5), seconds(-1), seconds(Infinity), seconds(NaN), seconds("bad"), seconds(35792), seconds(2147484), { duration: 35792, unit: "minutes" }, { duration: 1, unit: "hours" }]) {
    assert.equal(durationInMillis(args), null);
  }
  assert.equal(durationInMillis(seconds("5")), 5000);
  assert.equal(durationInMillis({ duration: 35791, unit: "minutes" }), 2147460000);
});

test("argument lookup time counts toward the duration", async (t) => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  let resolve;
  const deferred = new Promise((r) => { resolve = r; });
  const f = fixture({ first_person_entered_for_duration: () => deferred });
  f.transition(f.addDevice(), true);
  now += 2000;
  resolve([seconds(5)]);
  await flush();
  assert.equal([...f.timers][0].delay, 3000);
  await f.expire();
  assert.equal(f.calls.length, 1);
});

test("a changed Flow duration cannot run on the old deadline", async () => {
  const config = { first_person_entered_for_duration: [seconds(5)] };
  const f = fixture(config);
  f.transition(f.addDevice(), true);
  await flush();
  config.first_person_entered_for_duration = [seconds(10)];
  await f.expire();
  assert.equal(f.calls.length, 0);
});

test("every existing trigger gets an additive Compose variant preserving tokens and device filter", () => {
  const directory = `${__dirname}/../.homeycompose/flow/triggers`;
  const originals = fs.readdirSync(directory).filter((file) => !file.includes("_for_duration"));
  assert.equal(DEFINITIONS.length, originals.length);
  for (const definition of DEFINITIONS) {
    const original = JSON.parse(fs.readFileSync(`${directory}/${definition.id}.json`));
    const variant = JSON.parse(fs.readFileSync(`${directory}/${definition.id}_for_duration.json`));
    assert.deepEqual(variant.tokens, original.tokens);
    assert.deepEqual(variant.args.slice(0, -2), original.args || []);
    assert.equal(variant.id, `${original.id}_for_duration`);
    assert.deepEqual(variant.args.slice(-2).map(({ name }) => name), ["duration", "unit"]);
    assert.deepEqual(Object.keys(variant.title), Object.keys(variant.titleFormatted));
  }
});
