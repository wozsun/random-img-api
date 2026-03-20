import { fetchFromKv as fetchFromKvCf } from "./kv-cf.js";
import { fetchFromKv as fetchFromKvEo } from "./kv-eo.js";
import { fetchFromKv as fetchFromKvEsa } from "./kv-esa.js";

const KV_CACHE_TTL_MS = 60 * 1000;
const KV_NEGATIVE_CACHE_TTL_MS = 3 * 1000;

// 从环境变量读取 KV 提供商标识，默认为 ESA
const getKvProvider = (env) => env?.KV_PROVIDER || "ESA";

const KV_PROVIDER_MAP = {
	ESA: fetchFromKvEsa,
	CF: fetchFromKvCf,
	EO: fetchFromKvEo,
};

// 根据提供商配置分发 KV 读取请求
const fetchFromKv = async ({ env, namespace, key, type }) => {
	const provider = getKvProvider(env);
	const providerFetcher = KV_PROVIDER_MAP[provider];
	if (!providerFetcher) {
		return null;
	}
	return providerFetcher({ env, namespace, key, type });
};

const cacheStores = {
	jsonObject: new Map(),
	url: new Map(),
};

// 构造缓存键，优先使用自定义 cacheKey
const buildCacheKey = (namespace, key, cacheKey) => cacheKey || `${namespace}::${key}`;

// 从 Map 缓存中读取未过期的条目
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

// 将值写入缓存并设置过期时间，null 值使用较短的负缓存 TTL
const writeCache = (cacheStore, id, value, ttlMs) => {
	const normalizedValue = value ?? null;
	const ttl = normalizedValue === null ? KV_NEGATIVE_CACHE_TTL_MS : ttlMs;
	cacheStore.set(id, {
		value: normalizedValue,
		expiresAt: Date.now() + ttl,
	});
	return normalizedValue;
};

// 从缓存读取值，若未命中则调用 loader 加载并写入缓存
const loadCached = async ({ cacheStore, id, ttlMs, loader }) => {
	const cached = readCache(cacheStore, id);
	if (cached.hit) {
		return cached.value;
	}
	const loaded = await loader();
	return writeCache(cacheStore, id, loaded, ttlMs);
};

// 将原始字符串整理为单行内容，多行或非字符串返回 null
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

// 解析并规范化 URL 字符串，确保末尾带斜杠，无效时返回 null
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

// 获取经内存缓存的 KV JSON 对象
export const getKvJsonObjectCached = async ({ env, namespace, key, cacheKey = "", ttlMs = KV_CACHE_TTL_MS }) => {
	const id = buildCacheKey(namespace, key, cacheKey);
	return loadCached({
		cacheStore: cacheStores.jsonObject,
		id,
		ttlMs,
		loader: () => fetchFromKv({ env, namespace, key, type: "json" }),
	});
};

// 获取经内存缓存的 KV URL 字符串
export const getKvUrlCached = async ({ env, namespace, key, cacheKey = "", ttlMs = KV_CACHE_TTL_MS }) => {
	const id = buildCacheKey(namespace, key, cacheKey);
	return loadCached({
		cacheStore: cacheStores.url,
		id,
		ttlMs,
		loader: async () => {
			const raw = await fetchFromKv({ env, namespace, key, type: "text" });
			return parseUrl(toSingleTrimmedLine(raw));
		},
	});
};