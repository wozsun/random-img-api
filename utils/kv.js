import { detailedErrorResponse } from "./response.js";
import { fetchFromKv as fetchFromKvCf } from "./kv-cf.js";
import { fetchFromKv as fetchFromKvEsa } from "./kv-esa.js";

const KV_CACHE_TTL_MS = 60 * 1000;
const KV_NEGATIVE_CACHE_TTL_MS = 3 * 1000;

const getKvProvider = (env) => env?.KV_PROVIDER || "ESA";

const KV_PROVIDER_MAP = {
	ESA: fetchFromKvEsa,
	CF: fetchFromKvCf,
};

const fetchFromKv = async ({ env, namespace, key, type }) => {
	const provider = getKvProvider(env);
	const providerFetcher = KV_PROVIDER_MAP[provider];
	if (!providerFetcher) {
		return detailedErrorResponse(
			{ status: 500, message: "Internal Server Error: Unsupported KV_PROVIDER" },
			{ provider }
		);
	}
	return providerFetcher({ env, namespace, key, type });
};

const cacheStores = {
	jsonObject: new Map(),
	url: new Map(),
};

const buildCacheKey = (namespace, key, cacheKey) => cacheKey || `${namespace}::${key}`;

const readCache = (cacheStore, id) => {
	const cached = cacheStore.get(id);
	if (!cached) {
		return { hit: false, value: null };
	}
	if (Date.now() >= cached.expiresAt) {
		cacheStore.delete(id);
		return { hit: false, value: null };
	}
	return { hit: true, value: cached.value };
};

const writeCache = (cacheStore, id, value, ttlMs) => {
	const normalizedValue = value ?? null;
	const ttl = normalizedValue === null ? KV_NEGATIVE_CACHE_TTL_MS : ttlMs;
	cacheStore.set(id, {
		value: normalizedValue,
		expiresAt: Date.now() + ttl,
	});
	return normalizedValue;
};

const readCachedValue = async ({ cacheStore, id, ttlMs, loader }) => {
	const cached = readCache(cacheStore, id);
	if (cached.hit) {
		return cached.value;
	}
	const loaded = await loader();
	return writeCache(cacheStore, id, loaded, ttlMs);
};

const toSingleTrimmedLine = (raw) => {
	if (typeof raw !== "string") {
		return null;
	}
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length !== 1) {
		return null;
	}
	return lines[0];
};

const parseUrl = (line) => {
	if (!line) {
		return null;
	}
	try {
		const parsed = new URL(line);
		const normalized = parsed.toString();
		return normalized.endsWith("/") ? normalized : `${normalized}/`;
	} catch {
		return null;
	}
};

export const getKvJsonObjectCached = async ({ env, namespace, key, cacheKey = "", ttlMs = KV_CACHE_TTL_MS }) => {
	const id = buildCacheKey(namespace, key, cacheKey);
	return readCachedValue({
		cacheStore: cacheStores.jsonObject,
		id,
		ttlMs,
		loader: () => fetchFromKv({ env, namespace, key, type: "json" }),
	});
};

export const getKvUrlCached = async ({ env, namespace, key, cacheKey = "", ttlMs = KV_CACHE_TTL_MS }) => {
	const id = buildCacheKey(namespace, key, cacheKey);
	return readCachedValue({
		cacheStore: cacheStores.url,
		id,
		ttlMs,
		loader: async () => {
			const raw = await fetchFromKv({ env, namespace, key, type: "text" });
			return parseUrl(toSingleTrimmedLine(raw));
		},
	});
};