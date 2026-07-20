import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  assertTemporaryDatabaseName,
  cleanupTemporaryDatabase,
  createPostgresCleanupOperations,
  createTemporaryDatabase,
  runMigrationTests,
  runWithTemporaryDatabaseCleanup,
} from "../../scripts/test-migrations.mjs";

const databaseName = `metrics_migration_test_${"1".repeat(32)}`;

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function successfulCleanupOperations(events) {
  return {
    async terminateSessions(name) { events.push(`terminate:${name}`); },
    async dropDatabase(name) { events.push(`drop:${name}`); },
    async listDatabases() { events.push("list"); return ["postgres"]; },
  };
}

test("destructive cleanup rejects unsafe or caller-injected database names", async () => {
  assert.equal(assertTemporaryDatabaseName(databaseName), databaseName);
  for (const unsafeName of [
    "postgres",
    "metrics_migration_test_123456789abc",
    `metrics_migration_test_${"A".repeat(32)}`,
    `metrics_migration_test_${"1".repeat(31)}`,
    `metrics_migration_test_${"1".repeat(33)}`,
    `${databaseName};drop database postgres`,
  ]) {
    const events = [];
    await assert.rejects(cleanupTemporaryDatabase({
      databaseName: unsafeName,
      operations: successfulCleanupOperations(events),
    }), /internally generated full-UUID/);
    assert.deepEqual(events, []);
  }
  await assert.rejects(
    runMigrationTests({
      connectionString: "postgres://user:secret@db.example.test/postgres",
      databaseName,
    }),
    /Unsupported migration test option: databaseName/,
  );
});

test("pre-create enumeration refuses an existing reserved name without creating it", async () => {
  const events = [];
  await assert.rejects(createTemporaryDatabase({
    databaseName,
    operationTimeoutMs: 100,
    operations: {
      async listDatabases() { events.push("list"); return ["postgres", databaseName]; },
      async createDatabase() { events.push("unexpected-create"); },
    },
  }), /reserved temporary database name already exists/);
  assert.deepEqual(events, ["list"]);
});

test("duplicate or ambiguous create failure never terminates or drops an existing database", async () => {
  const events = [];
  const duplicate = Object.assign(new Error("database already exists"), { code: "42P04" });
  await assert.rejects(runWithTemporaryDatabaseCleanup({
    signalTarget: new EventEmitter(),
    exit: () => assert.fail("unexpected exit"),
    createDatabase: () => createTemporaryDatabase({
      databaseName,
      operationTimeoutMs: 100,
      operations: {
        async listDatabases() { events.push("pre-create-list"); return ["postgres"]; },
        async createDatabase() { events.push("create"); throw duplicate; },
      },
    }),
    run: async () => { events.push("unexpected-run"); },
    cleanup: async () => {
      await cleanupTemporaryDatabase({
        databaseName,
        operations: successfulCleanupOperations(events),
        operationTimeoutMs: 100,
      });
    },
  }), (error) => error === duplicate);
  assert.deepEqual(events, ["pre-create-list", "create"]);
});

test("confirmed creation cleans up normal exit and later setup or test failure", async (t) => {
  for (const scenario of [
    { name: "normal exit", run: async (events) => { events.push("run"); return "complete"; } },
    { name: "post-create failure", run: async (events) => { events.push("run"); throw new Error("setup failed"); } },
  ]) {
    await t.test(scenario.name, async () => {
      const events = [];
      const signalTarget = new EventEmitter();
      const operation = runWithTemporaryDatabaseCleanup({
        signalTarget,
        exit: () => assert.fail("unexpected exit"),
        createDatabase: async () => {
          assert.equal(signalTarget.listenerCount("SIGINT"), 1);
          assert.equal(signalTarget.listenerCount("SIGTERM"), 1);
          events.push("create");
        },
        run: () => scenario.run(events),
        cleanup: () => cleanupTemporaryDatabase({
          databaseName,
          operations: successfulCleanupOperations(events),
          operationTimeoutMs: 100,
        }),
      });
      if (scenario.name === "post-create failure") await assert.rejects(operation, /setup failed/);
      else assert.equal(await operation, "complete");
      assert.deepEqual(events, [
        "create", "run", `terminate:${databaseName}`, `drop:${databaseName}`, "list",
      ]);
      assert.equal(signalTarget.listenerCount("SIGINT"), 0);
      assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
    });
  }
});

test("primary and cleanup failures are both preserved", async () => {
  let caught;
  try {
    await runWithTemporaryDatabaseCleanup({
      signalTarget: new EventEmitter(),
      exit: () => assert.fail("unexpected exit"),
      createDatabase: async () => {},
      run: async () => { throw new Error("primary failure"); },
      cleanup: async () => { throw new Error("cleanup failure"); },
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AggregateError);
  assert.deepEqual(caught.errors.map(({ message }) => message), ["primary failure", "cleanup failure"]);
});

test("first signal during unresolved creation exits without cleanup or waiting", async () => {
  const signalTarget = new EventEmitter();
  const creationStarted = deferred();
  const creation = deferred();
  const events = [];
  const running = runWithTemporaryDatabaseCleanup({
    signalTarget,
    signalCleanupDeadlineMs: 20,
    createDatabase: async () => {
      events.push("create-started");
      creationStarted.resolve();
      return creation.promise;
    },
    run: async () => { events.push("unexpected-run"); },
    cleanup: async () => { events.push("unexpected-cleanup"); },
    exit: (code) => { events.push(`exit:${code}`); },
  });
  await creationStarted.promise;
  signalTarget.emit("SIGTERM");
  assert.deepEqual(events, ["create-started", "exit:143"]);
  creation.reject(new Error("creation interrupted"));
  await assert.rejects(running, /creation interrupted/);
  assert.deepEqual(events, ["create-started", "exit:143"]);
});

test("first signal applies a total deadline to stalled owned cleanup", async () => {
  const signalTarget = new EventEmitter();
  const runStarted = deferred();
  const releaseRun = deferred();
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const exited = deferred();
  const events = [];
  const running = runWithTemporaryDatabaseCleanup({
    signalTarget,
    signalCleanupDeadlineMs: 20,
    createDatabase: async () => {},
    run: async () => { runStarted.resolve(); await releaseRun.promise; },
    cleanup: async () => {
      events.push("cleanup");
      cleanupStarted.resolve();
      await releaseCleanup.promise;
    },
    exit: (code) => { events.push(`exit:${code}`); exited.resolve(code); },
  });
  await runStarted.promise;
  signalTarget.emit("SIGINT");
  await cleanupStarted.promise;
  assert.equal(await exited.promise, 1);
  assert.deepEqual(events, ["cleanup", "exit:1"]);
  releaseCleanup.resolve();
  releaseRun.resolve();
  await running;
  assert.equal(events.filter((event) => event === "cleanup").length, 1);
});

test("second signal forces immediate exit while owned cleanup is stalled", async () => {
  const signalTarget = new EventEmitter();
  const runStarted = deferred();
  const releaseRun = deferred();
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const exits = [];
  const running = runWithTemporaryDatabaseCleanup({
    signalTarget,
    signalCleanupDeadlineMs: 1_000,
    createDatabase: async () => {},
    run: async () => { runStarted.resolve(); await releaseRun.promise; },
    cleanup: async () => { cleanupStarted.resolve(); await releaseCleanup.promise; },
    exit: (code) => { exits.push(code); },
  });
  await runStarted.promise;
  signalTarget.emit("SIGINT");
  await cleanupStarted.promise;
  signalTarget.emit("SIGTERM");
  assert.deepEqual(exits, [143]);
  releaseCleanup.resolve();
  releaseRun.resolve();
  await running;
  assert.deepEqual(exits, [143]);
});

test("cleanup retries transient failures and verifies absence on a later enumeration", async () => {
  const events = [];
  let attempt = 0;
  const result = await cleanupTemporaryDatabase({
    databaseName,
    maxAttempts: 3,
    operationTimeoutMs: 100,
    retryDelay: async (failedAttempt) => { events.push(`retry:${failedAttempt}`); },
    operations: {
      async terminateSessions() {
        attempt += 1;
        events.push(`terminate:${attempt}`);
        if (attempt === 1) throw new Error("transient termination failure");
      },
      async dropDatabase() {
        events.push(`drop:${attempt}`);
        if (attempt === 1) throw new Error("transient drop failure");
      },
      async listDatabases() {
        events.push(`list:${attempt}`);
        return attempt === 1 ? ["postgres", databaseName] : ["postgres"];
      },
    },
  });
  assert.deepEqual(result, { attempts: 2, verifiedAbsent: true });
  assert.deepEqual(events, [
    "terminate:1", "drop:1", "list:1", "retry:1",
    "terminate:2", "drop:2", "list:2",
  ]);
});

test("cleanup fails closed when absence enumeration stalls or retains the database", async (t) => {
  await t.test("stalled enumeration", async () => {
    await assert.rejects(cleanupTemporaryDatabase({
      databaseName,
      maxAttempts: 1,
      operationTimeoutMs: 20,
      operations: {
        async terminateSessions() {},
        async dropDatabase() {},
        async listDatabases() { return new Promise(() => {}); },
      },
    }), /failed absence verification after 1 attempts/);
  });
  await t.test("database remains", async () => {
    const events = [];
    await assert.rejects(cleanupTemporaryDatabase({
      databaseName,
      maxAttempts: 2,
      operationTimeoutMs: 100,
      retryDelay: async () => {},
      operations: {
        async terminateSessions() { events.push("terminate"); },
        async dropDatabase() { events.push("drop"); },
        async listDatabases() { events.push("list"); return ["postgres", databaseName]; },
      },
    }), /failed absence verification after 2 attempts/);
    assert.deepEqual(events, ["terminate", "drop", "list", "terminate", "drop", "list"]);
  });
});

test("PostgreSQL cleanup bounds connections and queries and reconnects for every phase", async (t) => {
  await t.test("connection timeout", async () => {
    const operations = createPostgresCleanupOperations({
      adminConnectionString: "postgres://redacted.example.test/postgres",
      operationTimeoutMs: 20,
      createClient: async () => ({
        async connect() { return new Promise(() => {}); },
        async end() {},
      }),
    });
    await assert.rejects(operations.listDatabases(), /connection timed out after 20ms/);
  });

  await t.test("query timeout", async () => {
    const operations = createPostgresCleanupOperations({
      adminConnectionString: "postgres://redacted.example.test/postgres",
      operationTimeoutMs: 20,
      createClient: async () => ({
        async connect() {},
        async query() { return new Promise(() => {}); },
        async end() {},
      }),
    });
    await assert.rejects(operations.listDatabases(), /Enumerate PostgreSQL databases timed out after 20ms/);
  });

  await t.test("forced drop and reconnect", async () => {
    const clients = [];
    const queries = [];
    const createClient = async () => {
      const clientNumber = clients.length + 1;
      const client = {
        async connect() { queries.push(`connect:${clientNumber}`); },
        async query(text, values) {
          queries.push({ text, values, clientNumber });
          return text === "select datname from pg_database"
            ? { rows: [{ datname: "postgres" }] }
            : { rows: [] };
        },
        async end() { queries.push(`end:${clientNumber}`); },
      };
      clients.push(client);
      return client;
    };
    const operations = createPostgresCleanupOperations({
      adminConnectionString: "postgres://redacted.example.test/postgres",
      createClient,
      operationTimeoutMs: 100,
    });
    await operations.terminateSessions(databaseName);
    await operations.dropDatabase(databaseName);
    assert.deepEqual(await operations.listDatabases(), ["postgres"]);

    assert.equal(clients.length, 3);
    const queryCalls = queries.filter((entry) => typeof entry === "object");
    assert.match(queryCalls[0].text, /pg_terminate_backend/);
    assert.deepEqual(queryCalls[0].values, [databaseName]);
    assert.equal(queryCalls[1].text, `drop database if exists "${databaseName}" with (force)`);
    assert.equal(queryCalls[2].text, "select datname from pg_database");
    assert.deepEqual(
      queries.filter((entry) => typeof entry === "string"),
      ["connect:1", "end:1", "connect:2", "end:2", "connect:3", "end:3"],
    );
  });
});
