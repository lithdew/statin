import { DDSketch } from "@datadog/sketches-js";
import { Database } from "bun:sqlite";
import { outdent } from "outdent";

export namespace dd {
  export const DEFAULT_INTERVAL_DURATIONS: number[] = [
    1000, // second
    60 * 1000, // minute
    60 * 60 * 1000, // hour
    24 * 60 * 60 * 1000, // day
    7 * 24 * 60 * 60 * 1000, // week
    30 * 24 * 60 * 60 * 1000, // month
    365 * 24 * 60 * 60 * 1000, // year
  ];

  export const init = (db: Database) => {
    db.exec(outdent`
        create table if not exists stats (
            name text not null,
            key text not null,
            val real not null,
            recorded_at datetime not null,
            primary key (name, key)
        ) without rowid;

        create table if not exists stat_sketches (
            name text not null,
            key text not null,
            duration integer not null,
            start datetime not null,
            end datetime not null,
            count integer not null default 0,
            sum real not null default 0,
            min real not null default 0,
            max real not null default 0,
            p50 real not null default 0,
            p90 real not null default 0,
            p95 real not null default 0,
            p99 real not null default 0,
            sketch blob,
            primary key (name, key, duration, start)
        ) without rowid;
    `);
  };

  export const record = (
    db: Database,
    name: string,
    key: string,
    val: number | ((stat?: { value: number; recordedAt: number }) => number),
    timestamp: number = Date.now(),
    intervals: number[] = DEFAULT_INTERVAL_DURATIONS
  ) => {
    const stat = db
      .query<
        {
          val: number;
          recorded_at: number | bigint;
        },
        [string, string]
      >(`select val, recorded_at from stats where name = ? and key = ?`)
      .get(name, key);

    const now = timestamp;

    if (stat === null) {
      let next = val;
      if (typeof next === "function") {
        next = next();
      }

      db.query(
        `insert into stats (name, key, val, recorded_at) values (?, ?, ?, ?)`
      ).run(name, key, next, now);

      for (const interval of intervals) {
        sketch(db, name, key, next, now, interval);
      }

      return {
        status: "created" as const,
        value: next,
        recordedAt: now,
      };
    }

    let next = val;
    if (typeof next === "function") {
      next = next({
        value: Number(stat.val),
        recordedAt: Number(stat.recorded_at),
      });
    }

    stat.recorded_at = Number(stat.recorded_at);

    // If the timestamp is in the future, we can't record it.

    if (stat.recorded_at >= now) {
      throw new RangeError("Timestamp is in the past.");
    }

    db.query(
      `update stats set val = ?, recorded_at = ? where name = ? and key = ?`
    ).run(next, now, name, key);

    for (const interval of intervals) {
      sketch(db, name, key, next, now, interval);
    }

    return {
      status: "updated" as const,
      value: next,
      recordedAt: stat.recorded_at,
    };
  };

  export const sketch = (
    db: Database,
    name: string,
    key: string,
    val: number,
    timestamp: number,
    interval: number
  ) => {
    const start = Math.floor(timestamp / interval) * interval;
    const end = start + interval;

    let sketch: DDSketch;

    const cached = db
      .query<
        {
          sketch: Uint8Array;
          count: number | bigint;
          min: number;
          max: number;
          sum: number;
        },
        [string, string, number, number]
      >(
        outdent`
            select sketch, min, max, count, sum from stat_sketches
            where name = ? and key = ? and duration = ? and start = ?;
        `
      )
      .get(name, key, interval, start);

    if (cached !== null) {
      sketch = DDSketch.fromProto(cached.sketch);
      sketch.count = Number(cached.count);
      sketch.min = cached.min;
      sketch.max = cached.max;
      sketch.sum = cached.sum;
    } else {
      sketch = new DDSketch({ relativeAccuracy: 0.01 });
    }

    sketch.accept(val);

    db.query(
      outdent`
        insert into stat_sketches (name, key, duration, start, end, count, sum, min, max, p50, p90, p95, p99, sketch)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict (name, key, duration, start) do update set
        count = excluded.count,
        sum = excluded.sum,
        min = excluded.min,
        max = excluded.max,
        p50 = excluded.p50,
        p90 = excluded.p90,
        p95 = excluded.p95,
        p99 = excluded.p99,
        sketch = excluded.sketch;
      `
    ).run(
      name,
      key,
      interval,
      start,
      end,
      sketch.count,
      sketch.sum,
      sketch.min,
      sketch.max,
      sketch.getValueAtQuantile(0.5),
      sketch.getValueAtQuantile(0.9),
      sketch.getValueAtQuantile(0.95),
      sketch.getValueAtQuantile(0.99),
      sketch.toProto()
    );
  };

  export const query = (
    db: Database,
    name: string,
    key: string,
    duration: number,
    start: number,
    end: number
  ) => {
    let agg: DDSketch | null = null;
    const samples = [];

    const rows = db
      .query<
        {
          start: number | bigint;
          end: number | bigint;
          count: number | bigint;
          sum: number;
          min: number;
          max: number;
          p50: number;
          p90: number;
          p95: number;
          p99: number;
          sketch: Uint8Array;
        },
        [
          name: string,
          key: string,
          duration: number,
          start: number,
          end: number
        ]
      >(
        outdent`
            select start, end, count, sum, min, max, p50, p90, p95, p99, sketch
            from stat_sketches
            where name = ? and key = ? and duration = ? and start >= ? and end <= ?
            order by start asc;
        `
      )
      .all(name, key, duration, start, end);

    for (const { sketch, ...row } of rows) {
      const decoded = DDSketch.fromProto(sketch);
      decoded.count = Number(row.count);
      decoded.min = row.min;
      decoded.max = row.max;
      decoded.sum = row.sum;
      if (agg === null) {
        agg = decoded;
      } else {
        agg.merge(decoded);
      }
      samples.push({
        start: Number(row.start),
        end: Number(row.end),
        count: Number(row.count),
        sum: row.sum,
        min: row.min,
        max: row.max,
        p50: row.p50,
        p90: row.p90,
        p95: row.p95,
        p99: row.p99,
      });
    }

    if (agg === null) {
      return null;
    }

    return {
      agg: {
        count: agg.count,
        sum: agg.sum,
        min: agg.min,
        max: agg.max,
        p50: agg.getValueAtQuantile(0.5),
        p90: agg.getValueAtQuantile(0.9),
        p95: agg.getValueAtQuantile(0.95),
        p99: agg.getValueAtQuantile(0.99),
      },
      samples,
    };
  };
}
