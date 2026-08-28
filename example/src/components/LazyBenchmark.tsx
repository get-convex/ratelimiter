import { useMemo, useState } from "react";
import type React from "react";
import { type RateLimitConfig } from "@convex-dev/rate-limiter";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Monitor } from "./Monitor";

type Mode = "strict" | "sharded" | "lazy";

type BenchResult = NonNullable<
  ReturnType<typeof useQuery<typeof api.lazyBenchmark.latestRun>>
>["results"][number];

const MODES: Mode[] = ["strict", "sharded", "lazy"];

const MODE_COPY: Record<
  Mode,
  { title: string; config: string; blurb: string; accent: string }
> = {
  strict: {
    title: "Strict",
    config: "{ kind: 'token bucket', rate, period }",
    blurb:
      "Every caller reads and writes the same document, so concurrent callers conflict and Convex serializes them.",
    accent: "text-gray-700",
  },
  sharded: {
    title: "Sharded",
    config: "{ …, shards: N }",
    blurb:
      "The same budget spread over N documents. Conflicts get N times rarer, but the ceiling just moves.",
    accent: "text-yellow-700",
  },
  lazy: {
    title: "Lazy",
    config: "{ …, lazy: true }",
    blurb:
      "Callers read a recent snapshot and queue their consumption for a background worker, so they never conflict with each other.",
    accent: "text-primary-700",
  },
};

type Params = {
  concurrency: number;
  rounds: number;
  capacity: number;
  period: number;
  shards: number;
};

const PERIODS = [
  { label: "1s", ms: 1_000 },
  { label: "10s", ms: 10_000 },
  { label: "1m", ms: 60_000 },
];

const PRESETS: Record<string, { label: string; hint: string; params: Params }> =
  {
    throughput: {
      label: "Throughput",
      hint: "Budget comfortably bigger than the burst, so nothing is rejected and the only thing being measured is how fast each mode can apply the limit.",
      params: {
        concurrency: 64,
        rounds: 3,
        capacity: 600,
        period: 10_000,
        shards: 16,
      },
    },
    accuracy: {
      label: "Accuracy",
      hint: "Budget smaller than the burst, so you can see what lazy trades away: concurrent callers read the same snapshot and overshoot the cap.",
      params: {
        concurrency: 48,
        rounds: 1,
        capacity: 24,
        period: 60_000,
        shards: 4,
      },
    },
  };

function formatMs(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function LazyBenchmark() {
  const [params, setParams] = useState<Params>(PRESETS.throughput.params);
  const [preset, setPreset] = useState<string | null>("throughput");

  const start = useMutation(api.lazyBenchmark.start);
  const run = useQuery(api.lazyBenchmark.latestRun);
  const isRunning = run?.status === "running";

  const configs = useMemo(() => {
    // The refill rate is one full bucket per minute, so over a run lasting a
    // few seconds refill is negligible and `admitted` is a clean measure.
    const base = {
      kind: "token bucket",
      rate: params.capacity,
      period: params.period,
      capacity: params.capacity,
    } as const;
    return {
      strict: base as RateLimitConfig,
      sharded: { ...base, shards: params.shards } as RateLimitConfig,
      lazy: { ...base, lazy: true } as RateLimitConfig,
    };
  }, [params.capacity, params.period, params.shards]);

  const update = (patch: Partial<Params>) => {
    setParams((prev) => ({ ...prev, ...patch }));
    setPreset(null);
  };

  const applyPreset = (key: string) => {
    setParams(PRESETS[key].params);
    setPreset(key);
  };

  const strictResult = run?.results.find((r) => r.mode === "strict");
  const lazyResult = run?.results.find((r) => r.mode === "lazy");
  const perShard = params.capacity / params.shards;
  /** What the limit is configured to allow, sustained, in requests/second. */
  const allowedPerSecond = params.capacity / (params.period / 1000);

  return (
    <div className="w-full max-w-7xl mx-auto p-6 space-y-8 animate-fade-in">
      {/* Header */}
      <div className="text-center space-y-4 py-8">
        <h2 className="text-4xl font-bold bg-linear-to-r from-primary-600 to-primary-700 bg-clip-text text-transparent">
          Lazy vs. strict rate limiting
        </h2>
        <p className="text-lg text-gray-600 max-w-3xl mx-auto">
          The same token bucket, applied three ways. A run fires the same burst
          of simultaneous requests at all three at once, so you can watch them
          diverge live.
        </p>
      </div>

      {/* The three modes */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {MODES.map((mode) => (
          <div
            key={mode}
            className="bg-white rounded-2xl border border-gray-200 p-6 space-y-3"
          >
            <h3 className={`text-lg font-bold ${MODE_COPY[mode].accent}`}>
              {MODE_COPY[mode].title}
            </h3>
            <code className="block text-xs bg-gray-900 text-gray-300 rounded-lg px-3 py-2 overflow-x-auto">
              {MODE_COPY[mode].config}
            </code>
            <p className="text-sm text-gray-600">{MODE_COPY[mode].blurb}</p>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-8 space-y-8">
        <div className="flex flex-wrap items-center justify-center gap-3">
          {Object.entries(PRESETS).map(([key, { label }]) => (
            <button
              key={key}
              onClick={() => applyPreset(key)}
              className={`px-5 py-2 rounded-xl font-semibold transition-all duration-200 ${
                preset === key
                  ? "bg-primary-500 text-white shadow-lg"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {preset && (
          <p className="text-sm text-gray-600 text-center max-w-2xl mx-auto">
            {PRESETS[preset].hint}
          </p>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-6">
          <Field
            label="Concurrency"
            help="Requests in flight at once"
            value={params.concurrency}
            min={1}
            max={128}
            onChange={(concurrency) => update({ concurrency })}
          />
          <Field
            label="Rounds"
            help="Waves of that many requests"
            value={params.rounds}
            min={1}
            max={20}
            onChange={(rounds) => update({ rounds })}
          />
          <Field
            label="Capacity"
            help={`${allowedPerSecond.toFixed(1)} req/s allowed`}
            value={params.capacity}
            min={1}
            max={100_000}
            onChange={(capacity) => update({ capacity })}
          />
          <Field
            label="Shards"
            help={`${perShard.toFixed(1)} tokens per shard`}
            value={params.shards}
            min={1}
            max={64}
            onChange={(shards) => update({ shards })}
          />
          <div className="bg-gray-50 rounded-2xl p-5 space-y-2">
            <span className="block text-sm font-semibold text-gray-700">
              Period
            </span>
            <div className="flex gap-1">
              {PERIODS.map(({ label, ms }) => (
                <button
                  key={ms}
                  onClick={() => update({ period: ms })}
                  className={`flex-1 py-2 rounded-lg font-bold transition-all duration-200 ${
                    params.period === ms
                      ? "bg-primary-500 text-white"
                      : "bg-white border border-gray-300 text-gray-700 hover:bg-gray-100"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500">Time to refill the bucket</p>
          </div>
        </div>

        {perShard < 1 && (
          <p className="text-sm text-yellow-800 bg-yellow-50 border border-yellow-200 rounded-xl px-4 py-3">
            Each shard holds less than one token, so the sharded limit will
            reject everything. Sharding only works when the budget is big enough
            to divide.
          </p>
        )}

        <div className="flex flex-col items-center gap-4">
          <button
            onClick={() => void start({ params })}
            disabled={isRunning}
            className={`px-10 py-4 rounded-xl font-bold text-lg transition-all duration-200 ${
              isRunning
                ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                : "bg-primary-500 hover:bg-primary-600 text-white shadow-lg hover:shadow-xl transform hover:scale-105"
            }`}
          >
            {isRunning
              ? "Running…"
              : `Run ${params.rounds * params.concurrency} requests × ${MODES.length} modes`}
          </button>

          {run && (
            <div className="w-full max-w-2xl space-y-2">
              <div className="flex justify-between text-sm text-gray-600">
                <span className="font-mono">{run.phase}</span>
                <span>
                  {run.done} / {run.total}
                </span>
              </div>
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary-500 transition-all duration-300"
                  style={{ width: `${(run.done / run.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {run?.error && (
            <p className="text-error-700 bg-error-50 border border-error-200 rounded-xl px-4 py-3 font-mono text-sm">
              {run.error}
            </p>
          )}
        </div>
      </div>

      {/* Live token graphs. Sharded is left out: its value is stored per
          shard, which doesn't plot against the same axis. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {(["strict", "lazy"] as const).map((mode) => (
          <Monitor
            // Remount on a config change so the graph doesn't keep 10s of
            // history drawn against the old capacity.
            key={`${mode}:${params.capacity}:${params.shards}`}
            label={`${MODE_COPY[mode].title} — tokens left`}
            height="280px"
            getRateLimitValueQuery={api.lazyBenchmark.getRateLimit}
            opts={{
              name: `benchmark:${mode}`,
              config: configs[mode],
              getServerTimeMutation: api.lazyBenchmark.getServerTime,
            }}
          />
        ))}
      </div>
      <p className="text-sm text-gray-600 text-center max-w-3xl mx-auto">
        Both limits get the same burst at the same moment. Lazy drops
        immediately — the whole burst is admitted and queued in one go. Strict
        barely moves: it can't rewrite its document fast enough to drain the
        bucket before the refill tops it back up, so most of the budget is never
        spent.
      </p>

      {/* Results */}
      {run && run.results.length > 0 && (
        <div className="bg-white rounded-2xl shadow-xl border border-gray-100 p-8 overflow-x-auto">
          <h3 className="text-xl font-bold text-gray-800 mb-6">
            Results
            <span className="ml-3 text-sm font-normal text-gray-500">
              {run.params.concurrency} concurrent × {run.params.rounds} rounds
              against a limit of {run.params.capacity} per{" "}
              {run.params.period / 1000}s ={" "}
              {(run.params.capacity / (run.params.period / 1000)).toFixed(1)}{" "}
              req/s
            </span>
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-3 pr-4 font-semibold">Mode</th>
                <th className="py-3 pr-4 font-semibold text-right">Wall</th>
                <th className="py-3 pr-4 font-semibold text-right">
                  Admitted/s
                </th>
                <th className="py-3 pr-4 font-semibold text-right">
                  Latency p50
                </th>
                <th className="py-3 pr-4 font-semibold text-right">p95</th>
                <th className="py-3 pr-4 font-semibold text-right">max</th>
                <th className="py-3 pr-4 font-semibold text-right">Admitted</th>
                <th className="py-3 pr-4 font-semibold text-right">Limited</th>
                <th className="py-3 font-semibold text-right">Conflicts</th>
              </tr>
            </thead>
            <tbody>
              {MODES.filter((mode) =>
                run.results.some((r) => r.mode === mode),
              ).map((mode) => {
                const r = run.results.find((r) => r.mode === mode)!;
                // Requests that failed with a conflict aren't work the
                // limiter delivered, so rate them by what got admitted.
                const perSecond = r.admitted / (r.wallMs / 1000);
                const speedup =
                  strictResult && mode !== "strict"
                    ? strictResult.wallMs / r.wallMs
                    : null;
                const overshoot = r.admitted - run.params.capacity;
                return (
                  <tr key={mode} className="border-b border-gray-100">
                    <td className="py-3 pr-4">
                      <span
                        className={`font-semibold ${MODE_COPY[mode].accent}`}
                      >
                        {MODE_COPY[mode].title}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-right font-mono">
                      {formatMs(r.wallMs)}
                      {speedup && (
                        <span className="ml-2 text-success-600 font-semibold">
                          {speedup.toFixed(1)}×
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono">
                      {perSecond.toFixed(0)}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono">
                      {formatMs(r.latency.p50)}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono">
                      {formatMs(r.latency.p95)}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono">
                      {formatMs(r.latency.max)}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono">
                      {r.admitted}
                      {overshoot > 0 && (
                        <span className="ml-2 text-error-600 font-semibold">
                          +{overshoot} over cap
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-right font-mono">
                      {r.limited}
                    </td>
                    <td className="py-3 text-right font-mono">
                      {r.conflicts + r.errors}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {strictResult && lazyResult && (
            <Verdict
              capacity={run.params.capacity}
              allowedPerSecond={
                run.params.capacity / (run.params.period / 1000)
              }
              strict={strictResult}
              lazy={lazyResult}
            />
          )}
          <p className="text-sm text-gray-600 mt-6">
            Convex retries a write conflict for you, so contention mostly shows
            up as latency rather than as errors. The Conflicts column counts
            only the requests that still failed after those retries ran out.
          </p>
        </div>
      )}

      {/* Takeaway */}
      <div className="bg-linear-to-br from-gray-50 to-white rounded-2xl border border-gray-200 p-8 space-y-4">
        <h3 className="text-xl font-bold text-gray-800">The trade-off</h3>
        <p className="text-gray-600">
          A strict limit has a throughput ceiling of its own, set by how fast
          one document can be rewritten — roughly twenty-odd requests a second
          here. Configure a limit above that and you can never actually reach
          it: callers spend their time queued behind each other instead of
          spending the budget. A lazy limit never conflicts, so the rate you
          configure is the rate you get.
        </p>
        <p className="text-gray-600">
          In exchange it's{" "}
          <span className="font-semibold">eventually consistent</span>: every
          caller in a burst reads the same snapshot, so they can collectively
          overshoot the cap before the worker catches up — run the Accuracy
          preset to see it happen.
        </p>
        <p className="text-gray-600">
          Reach for <code className="font-mono text-primary-700">lazy</code>{" "}
          when you want to bound usage over time and a little overshoot is fine
          — LLM token budgets are the motivating case. Leave it off when a
          request must never be admitted past the limit.
        </p>
      </div>
    </div>
  );
}

function Verdict({
  capacity,
  allowedPerSecond,
  strict,
  lazy,
}: {
  capacity: number;
  allowedPerSecond: number;
  strict: BenchResult;
  lazy: BenchResult;
}) {
  // When requests were rejected the run was bound by the cap, not by how fast
  // the limit could be applied, so requests/second says nothing useful.
  const capacityBound = strict.limited > 0 || lazy.limited > 0;
  const strictPerSecond = strict.admitted / (strict.wallMs / 1000);
  const lazyPerSecond = lazy.admitted / (lazy.wallMs / 1000);
  const overshoot = lazy.admitted - capacity;

  if (capacityBound) {
    return (
      <Callout tone={overshoot > 0 ? "warn" : "neutral"}>
        The cap was <Num>{capacity}</Num>. Strict admitted{" "}
        <Num>{strict.admitted}</Num> and turned the rest away.{" "}
        {overshoot > 0 ? (
          <>
            Lazy admitted <Num>{lazy.admitted}</Num> — <Num>{overshoot}</Num>{" "}
            past the cap — because every caller in the burst read the same
            snapshot before any of the consumption had been applied.
          </>
        ) : (
          <>
            Lazy admitted <Num>{lazy.admitted}</Num>, landing inside the cap
            this time; widen the burst and it will start to overshoot.
          </>
        )}
      </Callout>
    );
  }

  if (strictPerSecond < allowedPerSecond) {
    return (
      <Callout tone="warn">
        This limit allows <Num>{allowedPerSecond.toFixed(1)} req/s</Num>, but
        strict mode only delivered <Num>{strictPerSecond.toFixed(0)} req/s</Num>{" "}
        — the limiter is the bottleneck, not the policy, and the budget goes
        unspent. Lazy delivered <Num>{lazyPerSecond.toFixed(0)} req/s</Num>, so
        the configured rate is actually reachable.
      </Callout>
    );
  }

  return (
    <Callout tone="neutral">
      Strict mode delivered <Num>{strictPerSecond.toFixed(0)} req/s</Num>{" "}
      against a limit of <Num>{allowedPerSecond.toFixed(1)} req/s</Num>, so it
      kept up here. Raise the limit past its write-throughput ceiling and it
      stops keeping up; lazy delivered{" "}
      <Num>{lazyPerSecond.toFixed(0)} req/s</Num>.
    </Callout>
  );
}

function Callout({
  tone,
  children,
}: {
  tone: "warn" | "neutral";
  children: React.ReactNode;
}) {
  return (
    <p
      className={`mt-6 rounded-xl px-5 py-4 text-sm border ${
        tone === "warn"
          ? "bg-error-50 border-error-200 text-error-900"
          : "bg-primary-50 border-primary-500/20 text-gray-700"
      }`}
    >
      {children}
    </p>
  );
}

function Num({ children }: { children: React.ReactNode }) {
  return <span className="font-mono font-semibold">{children}</span>;
}

function Field({
  label,
  help,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  help: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="bg-gray-50 rounded-2xl p-5 space-y-2">
      <label className="block text-sm font-semibold text-gray-700">
        {label}
      </label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const next = parseInt(e.target.value);
          if (!Number.isNaN(next)) {
            onChange(Math.max(min, Math.min(max, next)));
          }
        }}
        // Without this a scroll over a focused number input silently changes
        // the value, which here means quietly firing a much bigger run.
        onWheel={(e) => e.currentTarget.blur()}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-lg font-bold text-gray-900 focus:ring-2 focus:ring-primary-500 focus:border-primary-500 transition-all duration-200"
      />
      <p className="text-xs text-gray-500">{help}</p>
    </div>
  );
}

export default LazyBenchmark;
