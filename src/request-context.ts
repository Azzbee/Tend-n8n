import { AsyncLocalStorage } from "node:async_hooks";

// The private API route a store call runs for, so lock timings can name it.
export const requestPath = new AsyncLocalStorage<string>();
