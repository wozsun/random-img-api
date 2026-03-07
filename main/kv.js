// ===========================
// KV 通用工具函数
// ===========================

export const KV_CACHE_TTL_MS = 60 * 1000;

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

// 从 KV 读取文本值并做 trim 归一化，读取失败或非字符串时返回 null。
export const getKvText = async ({ namespace, key }) => {
	try {
		const value = await getEdgeKVClient(namespace).get(key, { type: "text" });
		if (typeof value !== "string") {
			return null;
		}
		const trimmed = value.trim();
		return trimmed || null;
	} catch {
		return null;
	}
};

// 带 TTL 的文本读取缓存。
export const getKvTextCached = async ({ namespace, key, cacheKey = "", ttlMs = KV_CACHE_TTL_MS }) => {
	const id = buildCacheKey(namespace, key, cacheKey);
	const now = Date.now();
	const cached = textCache.get(id);
	if (cached && now < cached.expiresAt) {
		return cached.value;
	}

	const value = await getKvText({ namespace, key });
	textCache.set(id, {
		value: value ?? null,
		expiresAt: now + ttlMs,
	});
	return value ?? null;
};

// 读取 KV JSON，并保证结果是非数组对象。
export const getKvJsonObjectCached = async ({ namespace, key, cacheKey = "", ttlMs = KV_CACHE_TTL_MS }) => {
	const id = buildCacheKey(namespace, key, cacheKey);
	const now = Date.now();
	const cached = jsonObjectCache.get(id);
	if (cached && now < cached.expiresAt) {
		return cached.value;
	}

	const rawValue = await getKvTextCached({
		namespace,
		key,
		cacheKey: `${id}::text`,
		ttlMs,
	});
	if (!rawValue) {
		jsonObjectCache.set(id, {
			value: null,
			expiresAt: now + ttlMs,
		});
		return null;
	}

	let parsed;
	try {
		parsed = JSON.parse(rawValue);
	} catch {
		jsonObjectCache.set(id, {
			value: null,
			expiresAt: now + ttlMs,
		});
		return null;
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		jsonObjectCache.set(id, {
			value: null,
			expiresAt: now + ttlMs,
		});
		return null;
	}

	jsonObjectCache.set(id, {
		value: parsed,
		expiresAt: now + ttlMs,
	});
	return parsed;
};

// 读取 URL 字符串并规范为以 `/` 结尾。
export const getKvNormalizedUrlCached = async ({ namespace, key, cacheKey = "", ttlMs = KV_CACHE_TTL_MS }) => {
	const id = buildCacheKey(namespace, key, cacheKey);
	const now = Date.now();
	const cached = normalizedUrlCache.get(id);
	if (cached && now < cached.expiresAt) {
		return cached.value;
	}

	const url = await getKvTextCached({
		namespace,
		key,
		cacheKey: `${id}::text`,
		ttlMs,
	});
	if (!url) {
		normalizedUrlCache.set(id, {
			value: null,
			expiresAt: now + ttlMs,
		});
		return null;
	}

	const normalizedWithSlash = url.endsWith("/") ? url : `${url}/`;
	normalizedUrlCache.set(id, {
		value: normalizedWithSlash,
		expiresAt: now + ttlMs,
	});
	return normalizedWithSlash;
};
