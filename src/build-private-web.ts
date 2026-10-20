const result = await Bun.build({
  entrypoints: ["src/private-web-client.ts"],
  outdir: "web/private",
  naming: "app.js",
  target: "browser",
  minify: true,
});
if (!result.success)
  throw new AggregateError(result.logs, "Private dashboard build failed");
console.log("Built private browser assets. No account data included.");

export {};
