// ===========================
// KV 通用工具函数
// ===========================

export const KV_CACHE_TTL_MS = 60 * 1000;
const KV_NEGATIVE_CACHE_TTL_MS = 3 * 1000;
const KV_GET_MAX_ATTEMPTS = 5;
const KV_RETRY_BASE_DELAY_MS = 50;

// 懒初始化并复用 EdgeKV 客户端，按 namespace 隔离实例。
const edgeKVClients = new Map();
const getEdgeKVClient = (namespace) => {
	if (!edgeKVClients.has(namespace)) {
		edgeKVClients.set(namespace, new EdgeKV({ namespace }));
	}
	return edgeKVClients.get(namespace);
};

const textCache = new Map();
const jsonObjectCache = new Map();
const normalizedUrlCache = new Map();

const buildCacheKey = (namespace, key, cacheKey) => cacheKey || `${namespace}::${key}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const computeCacheExpiresAt = (baseNow, value, ttlMs) =>
	baseNow + (value === null ? KV_NEGATIVE_CACHE_TTL_MS : ttlMs);
const getCacheValue = (cacheStore, id) => {
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
const setCacheValue = (cacheStore, id, value, ttlMs) => {
	const normalized = value ?? null;
	const now = Date.now();
	cacheStore.set(id, {
		value: normalized,
		expiresAt: computeCacheExpiresAt(now, normalized, ttlMs),
	});
	return normalized;
};

// 从 KV 读取文本值并做 trim 归一化，读取失败或非字符串时返回 null。
export const getKvText = async ({ namespace, key }) => {
	for (let attempt = 1; attempt <= KV_GET_MAX_ATTEMPTS; attempt++) {
		try {
			const value = await getEdgeKVClient(namespace).get(key, { type: "text" });
			if (typeof value !== "string") {
				return null;
			}
			const trimmed = value.trim();
			return trimmed || null;
		} catch {
			if (attempt >= KV_GET_MAX_ATTEMPTS) {
				return null;
			}
			await sleep(KV_RETRY_BASE_DELAY_MS * attempt);
		}
	}

	return null;
};

// 带 TTL 的文本读取缓存。
export const getKvTextCached = async ({ namespace, key, cacheKey = "", ttlMs = KV_CACHE_TTL_MS }) => {
	const id = buildCacheKey(namespace, key, cacheKey);
	const cacheResult = getCacheValue(textCache, id);
	if (cacheResult.hit) {
		return cacheResult.value;
	}

	const value = await getKvText({ namespace, key });
	return setCacheValue(textCache, id, value, ttlMs);
};

// 读取 KV JSON，并保证结果是非数组对象。
export const getKvJsonObjectCached = async ({ namespace, key, cacheKey = "", ttlMs = KV_CACHE_TTL_MS }) => {
	const id = buildCacheKey(namespace, key, cacheKey);
	const cacheResult = getCacheValue(jsonObjectCache, id);
	if (cacheResult.hit) {
		return cacheResult.value;
	}

	const rawValue = await getKvTextCached({
		namespace,
		key,
		cacheKey: `${id}::text`,
		ttlMs,
	});
	if (!rawValue) {
		return setCacheValue(jsonObjectCache, id, null, ttlMs);
	}

	let parsed;
	try {
		parsed = JSON.parse(rawValue);
	} catch {
		return setCacheValue(jsonObjectCache, id, null, ttlMs);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return setCacheValue(jsonObjectCache, id, null, ttlMs);
	}

	return setCacheValue(jsonObjectCache, id, parsed, ttlMs);
};

// 读取 URL 字符串并规范为以 `/` 结尾。
export const getKvNormalizedUrlCached = async ({ namespace, key, cacheKey = "", ttlMs = KV_CACHE_TTL_MS }) => {
	const id = buildCacheKey(namespace, key, cacheKey);
	const cacheResult = getCacheValue(normalizedUrlCache, id);
	if (cacheResult.hit) {
		return cacheResult.value;
	}

	const url = await getKvTextCached({
		namespace,
		key,
		cacheKey: `${id}::text`,
		ttlMs,
	});
	if (!url) {
		return setCacheValue(normalizedUrlCache, id, null, ttlMs);
	}

	const normalizedWithSlash = url.endsWith("/") ? url : `${url}/`;
	return setCacheValue(normalizedUrlCache, id, normalizedWithSlash, ttlMs);
};
