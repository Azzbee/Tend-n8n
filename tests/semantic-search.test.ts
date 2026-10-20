import { describe, expect, it } from "vitest";
import {
  splitSemanticPassages,
  validateEmbedding,
  OllamaEmbeddingClient,
  LocalModelCoordinator,
  embedPassages,
} from "../src/semantic-search.ts";

const digest = "sha256:" + "a".repeat(64);
const vector = (): number[] =>
  Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));

describe("semantic passages", () => {
  it("preserves every code point and UTF-16 offset including emoji and combining marks", () => {
    const text = "A😀 é漢字\n".repeat(300);
    const passages = splitSemanticPassages(text, 73);
    expect(passages.map((p) => text.slice(p.start, p.end)).join("")).toBe(text);
    expect(passages.map((p) => p.text).join("")).toBe(text);
    expect(passages.every((p) => !/[\uD800-\uDBFF]$/.test(p.text))).toBe(true);
    expect(passages.every((p) => Array.from(p.text).length <= 73)).toBe(true);
    expect(passages.map((p) => p.index)).toEqual(passages.map((_, i) => i));
  });
  it("does not invent a passage for empty input or accept invalid bounds", () => {
    expect(splitSemanticPassages("")).toEqual([]);
    expect(() => splitSemanticPassages("hi", 0)).toThrow();
    expect(() => splitSemanticPassages("hi", 900)).toThrow();
  });
});

describe("embedding validation", () => {
  it("accepts only finite, nonzero, 768-dimensional vectors", () => {
    expect(validateEmbedding(vector())).toHaveLength(768);
    for (const bad of [
      [],
      [1],
      Array(768).fill(0),
      Array(768).fill(NaN),
      Array(768).fill(Infinity),
      Array(768).fill(1e300),
      Array(768).fill(1e-300),
      "no",
      [...vector().slice(0, 767), "1"],
    ]) {
      expect(() => validateEmbedding(bad)).toThrow();
    }
  });
});

describe("pinned local embedding endpoint", () => {
  it("checks the installed full digest and sends truncate:false to the fixed local endpoint", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const client = new OllamaEmbeddingClient({
      digest,
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(
          JSON.stringify(
            url.endsWith("/api/tags")
              ? { models: [{ name: "granite-embedding:278m", digest }] }
              : { model: "granite-embedding:278m", embeddings: [vector()] },
          ),
        );
      },
    });
    expect(await client.embed("bonjour")).toEqual(vector());
    expect(calls.map((x) => x.url)).toEqual([
      "http://127.0.0.1:11434/api/tags",
      "http://127.0.0.1:11434/api/embed",
    ]);
    expect(calls[1]?.body).toEqual({
      model: "granite-embedding:278m",
      input: "bonjour",
      truncate: false,
      keep_alive: "30s",
    });
  });
  it("rejects a model tag which changed digest before inference", async () => {
    let calls = 0;
    const client = new OllamaEmbeddingClient({
      digest,
      fetch: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "granite-embedding:278m",
                digest: "sha256:" + "b".repeat(64),
              },
            ],
          }),
        );
      },
    });
    await expect(client.embed("hello")).rejects.toThrow("digest");
    expect(calls).toBe(1);
  });
  it("rejects oversized, invalid, multiple and zero embeddings", async () => {
    for (const response of [
      "x".repeat(100000),
      "{",
      JSON.stringify({ embeddings: [vector(), vector()] }),
      JSON.stringify({ embeddings: [Array(768).fill(0)] }),
    ]) {
      const client = new OllamaEmbeddingClient({
        digest,
        fetch: async (input) =>
          new Response(
            String(input).endsWith("/api/tags")
              ? JSON.stringify({
                  models: [{ name: "granite-embedding:278m", digest }],
                })
              : response,
          ),
      });
      await expect(client.embed("hello")).rejects.toThrow();
    }
  });
  it("rejects unknown digest strings and empty or excessive input", async () => {
    expect(() => new OllamaEmbeddingClient({ digest: "latest" })).toThrow(
      "digest",
    );
    const client = new OllamaEmbeddingClient({ digest });
    await expect(client.embed("")).rejects.toThrow("input");
    await expect(client.embed("a".repeat(4001))).rejects.toThrow("input");
  });
  it("only treats a confirmed context error as a reason to split", async () => {
    const client = new OllamaEmbeddingClient({
      digest,
      fetch: async (input) =>
        new Response(
          JSON.stringify(
            String(input).endsWith("/api/tags")
              ? { models: [{ name: "granite-embedding:278m", digest }] }
              : { error: "the input length exceeds the context length" },
          ),
          { status: String(input).endsWith("/api/tags") ? 200 : 400 },
        ),
    });
    await expect(client.embed("hello")).rejects.toMatchObject({
      name: "EmbeddingContextError",
    });
  });
});

describe("context-safe passage retry", () => {
  it("splits confirmed context failures without losing the tail", async () => {
    const result = await embedPassages(
      "abc😀def漢字XYZ",
      {
        embed: async (text) => {
          if (Array.from(text).length > 3)
            throw Object.assign(new Error("context"), {
              name: "EmbeddingContextError",
            });
          return vector();
        },
      },
      new AbortController().signal,
    );
    expect(result.map((x) => x.text).join("")).toBe("abc😀def漢字XYZ");
    expect(result.every((x) => Array.from(x.text).length <= 3)).toBe(true);
    expect(result.map((x) => x.index)).toEqual(result.map((_, i) => i));
  });
  it("never retries an unrelated inference failure as truncation", async () => {
    let calls = 0;
    await expect(
      embedPassages(
        "hello",
        {
          embed: async () => {
            calls++;
            throw new Error("offline");
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("offline");
    expect(calls).toBe(1);
  });
});

describe("local model coordinator", () => {
  it("runs one task at a time and gives waiting foreground work priority", async () => {
    const coordinator = new LocalModelCoordinator(4);
    let release: (() => void) | undefined;
    const order: string[] = [];
    const first = coordinator.run("background", async () => {
      order.push("first");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await Promise.resolve();
    const second = coordinator.run("background", async () => {
      order.push("background");
    });
    const third = coordinator.run("foreground", async () => {
      order.push("foreground");
    });
    release?.();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "foreground", "background"]);
  });
  it("bounds queue size and rejects cancelled waiting tasks", async () => {
    const coordinator = new LocalModelCoordinator(1);
    let release: (() => void) | undefined;
    const first = coordinator.run(
      "background",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const controller = new AbortController();
    const second = coordinator.run(
      "background",
      async () => 42,
      controller.signal,
    );
    const rejection = expect(second).rejects.toThrow("cancel");
    await expect(coordinator.run("foreground", async () => 0)).rejects.toThrow(
      "queue",
    );
    controller.abort();
    release?.();
    await first;
    await rejection;
  });
});

it("loads the semantic module in the production strip-only runtime", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(new URL("../src/semantic-search.ts", import.meta.url).href)});console.log("semantic-loaded");`,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("semantic-loaded");
});

it("unloads only the pinned embedding tag through an explicit local operation", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const client = new OllamaEmbeddingClient({
    digest,
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({ done: true, done_reason: "unload" }),
      );
    },
  });
  await client.unload();
  expect(calls).toEqual([
    {
      url: "http://127.0.0.1:11434/api/generate",
      body: {
        model: "granite-embedding:278m",
        prompt: "",
        keep_alive: 0,
        stream: false,
      },
    },
  ]);
});
