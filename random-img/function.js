import { detailedErrorResponse, jsonSuccessResponse } from "../main/response.js";

// ===========================
// 随机图片 API 配置
// ===========================
const RANDOM_IMG_CONFIG = {
	BASE_IMAGE_URL_KEY: "BASE_IMAGE_URL", 			// KV 存储中图片基础路径的键名
	FOLDER_MAP_KEY: "FOLDER_MAP", 					// KV 存储中目录映射的键名
	KV_NAMESPACE: "random-img-config", 				// KV 命名空间
	FOLDER_MAP_CACHE_TTL_MS: 60 * 1000, 			// FOLDER_MAP 本地缓存时长（毫秒）
	BASE_IMAGE_URL_CACHE_TTL_MS: 60 * 1000, 		// BASE_IMAGE_URL 本地缓存时长（毫秒）
	ALLOWED_PARAMS: new Set(["d", "b", "t", "m"]), 	// 允许的查询参数：d->device, b->brightness, t->theme, m->method
	VALID_DEVICES: new Set(["pc", "mb", "r"]),     	// 合法设备类型（r 表示忽略设备）
	VALID_BRIGHTNESS: new Set(["dark", "light"]),  	// 合法明暗类型
	VALID_METHODS: new Set(["proxy", "redirect"]), 	// 合法方法（proxy、redirect）
};

const VALID_DEVICES_LIST = Array.from(RANDOM_IMG_CONFIG.VALID_DEVICES);
const VALID_BRIGHTNESS_LIST = Array.from(RANDOM_IMG_CONFIG.VALID_BRIGHTNESS);
const VALID_METHODS_LIST = Array.from(RANDOM_IMG_CONFIG.VALID_METHODS);
// 预计算 Set 对应的数组，避免在请求路径中重复 Array.from

// 复用同一个 EdgeKV 客户端，避免重复创建实例
const edgeKV = new EdgeKV({ namespace: RANDOM_IMG_CONFIG.KV_NAMESPACE });

// ===========================
// 随机图片 API 错误定义
// ===========================
const RANDOM_IMG_ERRORS = {
	INVALID_QUERY_PARAMS: { status: 400, message: "Bad Request: Invalid query parameters" },
	INVALID_DEVICE: { status: 400, message: "Bad Request: Invalid device" },
	INVALID_BRIGHTNESS: { status: 400, message: "Bad Request: Invalid brightness" },
	INVALID_THEME: { status: 400, message: "Bad Request: Invalid theme" },
	INVALID_METHOD: { status: 400, message: "Bad Request: Invalid method" },
	BASE_IMAGE_URL_CONFIG_ERROR: { status: 500, message: "Internal Server Error: BASE_IMAGE_URL is invalid or missing in KV" },
	FOLDER_MAP_CONFIG_ERROR: { status: 500, message: "Internal Server Error: FOLDER_MAP is invalid or missing in KV" },
	NO_IMAGES_FOR_COMBINATION: { status: 404, message: "Not Found: No available images for the selected filters" },
	NO_AVAILABLE_IMAGES: { status: 404, message: "Not Found: No available images" },
	UPSTREAM_BAD_STATUS: { status: 502, message: "Bad Gateway: Upstream image service responded with a non-success status" },
	UPSTREAM_FETCH_EXCEPTION: { status: 502, message: "Bad Gateway: Failed to reach upstream image service due to network/runtime exception" },
};

const FOLDER_MAP_CONFIG_ERROR_DETAILS = {
	configKey: RANDOM_IMG_CONFIG.FOLDER_MAP_KEY,
	namespace: RANDOM_IMG_CONFIG.KV_NAMESPACE,
	hint: "Ensure FOLDER_MAP exists in KV and contains a valid JSON object",
};

const BASE_IMAGE_URL_CONFIG_ERROR_DETAILS = {
	configKey: RANDOM_IMG_CONFIG.BASE_IMAGE_URL_KEY,
	namespace: RANDOM_IMG_CONFIG.KV_NAMESPACE,
	hint: "Ensure BASE_IMAGE_URL exists in KV and is a non-empty URL string",
};

// 构造字段类错误响应
const invalidFieldError = (error, field, received, allowed) =>
	detailedErrorResponse(error, { field, received, allowed });

// 通用查询参数白名单校验：优先在业务处理前返回错误
const validateAllowedQueryParams = (params, allowedParams) => {
	const invalidParams = [];
	for (const key of params.keys()) {
		if (!allowedParams.has(key)) {
			invalidParams.push(key);
		}
	}

	if (invalidParams.length === 0) {
		return null;
	}

	return detailedErrorResponse(RANDOM_IMG_ERRORS.INVALID_QUERY_PARAMS, {
		invalidParams,
		allowedParams: Array.from(allowedParams),
	});
};

let folderMapCache = {
	value: null,
	expiresAt: 0,
};
// 进程内缓存：仅在当前边缘实例复用，跨实例/冷启动不共享

let baseImageUrlCache = {
	value: null,
	expiresAt: 0,
};
// 进程内缓存：仅在当前边缘实例复用，跨实例/冷启动不共享

// 从 KV 读取文本并去除首尾空白
const getKvText = async (key) => {
	try {
		const value = await edgeKV.get(key, { type: "text" });
		if (typeof value !== "string") {
			return null;
		}
		const trimmed = value.trim();
		return trimmed || null;
	} catch {
		return null;
	}
};

// 判断是否为“非数组且非 null”的对象
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

// 校验 FOLDER_MAP 整体结构是否合法
const validateFolderMap = (folderMap) => {
	if (!isPlainObject(folderMap)) {
		return false;
	}

	const deviceKeys = Object.keys(folderMap);
	if (deviceKeys.length === 0) {
		return false;
	}

	for (const device of deviceKeys) {
		if (!RANDOM_IMG_CONFIG.VALID_DEVICES.has(device) || device === "r") {
			return false;
		}

		const brightnessMap = folderMap[device];
		if (!isPlainObject(brightnessMap)) {
			return false;
		}

		for (const brightness of Object.keys(brightnessMap)) {
			if (!RANDOM_IMG_CONFIG.VALID_BRIGHTNESS.has(brightness)) {
				return false;
			}

			const themeMap = brightnessMap[brightness];
			if (!isPlainObject(themeMap)) {
				return false;
			}

			for (const [theme, count] of Object.entries(themeMap)) {
				if (!theme || !Number.isFinite(Number(count)) || Number(count) < 0) {
					return false;
				}
			}
		}
	}

	return true;
};

// 从 KV 读取并解析 FOLDER_MAP，返回统一结构
const getFolderMapFromKV = async () => {
	// 命中 TTL 时直接复用，减少 KV 读取与 JSON 解析成本
	if (folderMapCache.value && Date.now() < folderMapCache.expiresAt) {
		return { folderMap: folderMapCache.value, errorKey: null };
	}

	const rawValue = await getKvText(RANDOM_IMG_CONFIG.FOLDER_MAP_KEY);
	if (!rawValue) {
		return { folderMap: null, errorKey: "FOLDER_MAP_CONFIG_ERROR" };
	}

	let parsed;
	try {
		parsed = JSON.parse(rawValue);
	} catch {
		return { folderMap: null, errorKey: "FOLDER_MAP_CONFIG_ERROR" };
	}

	if (!validateFolderMap(parsed)) {
		return { folderMap: null, errorKey: "FOLDER_MAP_CONFIG_ERROR" };
	}

	folderMapCache = {
		value: parsed,
		expiresAt: Date.now() + RANDOM_IMG_CONFIG.FOLDER_MAP_CACHE_TTL_MS,
	};
	// 缓存写回：后续同实例请求在 TTL 内可直接命中

	return { folderMap: parsed, errorKey: null };
};

// 从 KV 读取图片基础 URL，并保证结尾带 `/`
const getBaseImageUrlFromKV = async () => {
	if (baseImageUrlCache.value && Date.now() < baseImageUrlCache.expiresAt) {
		return baseImageUrlCache.value;
	}

	const normalizedUrl = await getKvText(RANDOM_IMG_CONFIG.BASE_IMAGE_URL_KEY);
	if (!normalizedUrl) {
		return null;
	}

	const normalizedWithSlash = normalizedUrl.endsWith("/") ? normalizedUrl : `${normalizedUrl}/`;
	baseImageUrlCache = {
		value: normalizedWithSlash,
		expiresAt: Date.now() + RANDOM_IMG_CONFIG.BASE_IMAGE_URL_CACHE_TTL_MS,
	};

	return normalizedWithSlash;
};

// ===========================
// 随机图片主处理逻辑
// ===========================
export const handleRandomImg = async (request) => {
	const url = new URL(request.url);
	const params = url.searchParams;

	// 第一步：优先校验链接参数合法性，再做后续处理
	const invalidParamsResponse = validateAllowedQueryParams(params, RANDOM_IMG_CONFIG.ALLOWED_PARAMS);
	if (invalidParamsResponse) {
		return invalidParamsResponse;
	}

	const method = params.get("m")?.toLowerCase() || "proxy";

	// 校验 method 参数：仅允许 proxy 或 redirect（优先返回，避免无效请求触发 KV 读取）
	if (!RANDOM_IMG_CONFIG.VALID_METHODS.has(method)) {
		return invalidFieldError(RANDOM_IMG_ERRORS.INVALID_METHOD, "m", method, VALID_METHODS_LIST);
	}

	const requestedDevice = params.get("d")?.toLowerCase() || null;
	if (requestedDevice && !RANDOM_IMG_CONFIG.VALID_DEVICES.has(requestedDevice)) {
		return invalidFieldError(RANDOM_IMG_ERRORS.INVALID_DEVICE, "d", requestedDevice, VALID_DEVICES_LIST);
	}

	const userAgent = request.headers.get("User-Agent") || "";
	const isMobile = /Mobi|Android|iPhone/i.test(userAgent);
	const device = requestedDevice || (isMobile ? "mb" : "pc");
	const requestedBrightness = params.get("b")?.toLowerCase() || null;
	if (requestedBrightness && !RANDOM_IMG_CONFIG.VALID_BRIGHTNESS.has(requestedBrightness)) {
		return invalidFieldError(RANDOM_IMG_ERRORS.INVALID_BRIGHTNESS, "b", requestedBrightness, VALID_BRIGHTNESS_LIST);
	}

	const themeParams = Array.from(new Set(params
		.getAll("t")
		.flatMap((value) => value.split(","))
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean)));

	// 处理 device 参数
	const deviceCandidates =
		device === "r"
			? Array.from(RANDOM_IMG_CONFIG.VALID_DEVICES)
				.filter((candidate) => candidate !== "r")
			: [device];

	// 处理 brightness 参数
	const brightnessCandidates = requestedBrightness ? [requestedBrightness] : VALID_BRIGHTNESS_LIST;

	const { folderMap, errorKey: folderMapErrorKey } = await getFolderMapFromKV();
	if (folderMapErrorKey) {
		return detailedErrorResponse(RANDOM_IMG_ERRORS[folderMapErrorKey], FOLDER_MAP_CONFIG_ERROR_DETAILS);
	}

	// 处理 theme 参数
	const validThemes = Array.from(
		new Set(
			Object.values(folderMap).flatMap((deviceMap) =>
				Object.values(deviceMap ?? {}).flatMap((brightnessMap) =>
					Object.keys(brightnessMap ?? {})
				)
			)
		)
	);
	const validThemesSet = new Set(validThemes);
	const invalidTheme = themeParams.find((candidateTheme) => !validThemesSet.has(candidateTheme));
	if (invalidTheme) {
		return invalidFieldError(RANDOM_IMG_ERRORS.INVALID_THEME, "t", invalidTheme, validThemes);
	}
	const themeCandidates = themeParams.length > 0 ? themeParams : validThemes;

	const candidates = [];
	for (const candidateDevice of deviceCandidates) {
		const deviceMap = folderMap[candidateDevice];
		for (const b of brightnessCandidates) {
			for (const t of themeCandidates) {
				const count = deviceMap[b]?.[t] ?? 0;
				if (count > 0) {
					candidates.push({ device: candidateDevice, brightness: b, theme: t, count });
				}
			}
		}
	}

	if (candidates.length === 0) {
		if (requestedBrightness || themeParams.length > 0) {
			return detailedErrorResponse(RANDOM_IMG_ERRORS.NO_IMAGES_FOR_COMBINATION, {
				filters: {
					device,
					brightness: requestedBrightness,
					themes: themeCandidates,
				},
			});
		}
		return detailedErrorResponse(RANDOM_IMG_ERRORS.NO_AVAILABLE_IMAGES, {
			hint: "Check FOLDER_MAP counts in KV to ensure at least one image count is greater than 0",
		});
	}

	// 加权抽样：按 count 作为权重选择候选组合，保证“每张图”更接近等概率
	const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.count, 0);
	const randomWeight = Math.floor(Math.random() * totalWeight) + 1;
	let accumulatedWeight = 0;
	let selectedFolder = candidates[0];
	for (const candidate of candidates) {
		accumulatedWeight += candidate.count;
		if (accumulatedWeight >= randomWeight) {
			selectedFolder = candidate;
			break;
		}
	}

	const baseImageUrl = await getBaseImageUrlFromKV();
	if (!baseImageUrl) {
		return detailedErrorResponse(RANDOM_IMG_ERRORS.BASE_IMAGE_URL_CONFIG_ERROR, BASE_IMAGE_URL_CONFIG_ERROR_DETAILS);
	}

	// 随机选取图片编号
	const imageNumber = Math.floor(Math.random() * selectedFolder.count) + 1;
	const imageFilename = `${String(imageNumber).padStart(6, "0")}.webp`;
	const imageUrl = `${baseImageUrl}${selectedFolder.device}-${selectedFolder.brightness}/${selectedFolder.theme}/${imageFilename}`;

	// method=redirect 返回 302；method=proxy 透传图片内容
	if (method === "redirect") {
		return new Response(null, {
			status: 302,
			headers: { Location: imageUrl },
		});
	}

	try {
		const upstreamResponse = await fetch(imageUrl);

		if (!upstreamResponse.ok) {
			return detailedErrorResponse(RANDOM_IMG_ERRORS.UPSTREAM_BAD_STATUS, {
				upstreamStatus: upstreamResponse.status,
				upstreamStatusText: upstreamResponse.statusText || undefined,
				hint: "Upstream responded but did not return a success status",
			});
		}

		const headers = new Headers(upstreamResponse.headers);
		if (!headers.has("Cache-Control")) {
			headers.set("Cache-Control", "public, max-age=3600");
		}

		return new Response(upstreamResponse.body, {
			status: upstreamResponse.status,
			headers,
		});
	} catch {
		return detailedErrorResponse(RANDOM_IMG_ERRORS.UPSTREAM_FETCH_EXCEPTION, {
			hint: "Upstream request failed before receiving a valid response",
		});
	}
};

// 统计当前 FOLDER_MAP 中的图片数量信息
const buildRandomImgCountData = (folderMap) => {
	const groupTotals = {};
	const themeTotals = {};
	const themeDetails = [];
	let totalImages = 0;

	for (const device of Object.keys(folderMap).sort()) {
		for (const brightness of Object.keys(folderMap[device]).sort()) {
			const groupKey = `${device}-${brightness}`;
			let groupTotal = 0;

			for (const theme of Object.keys(folderMap[device][brightness]).sort()) {
				const count = Number(folderMap[device][brightness][theme] ?? 0);
				groupTotal += count;
				totalImages += count;
				themeTotals[theme] = (themeTotals[theme] ?? 0) + count;
				themeDetails.push({ theme, device, brightness, count });
			}

			groupTotals[groupKey] = groupTotal;
		}
	}

	themeDetails.sort((a, b) =>
		a.theme.localeCompare(b.theme) ||
		a.device.localeCompare(b.device) ||
		a.brightness.localeCompare(b.brightness)
	);

	return {
		totalImages,
		groupTotals,
		themeTotals,
		themeDetails,
	};
};

// 返回图片数量统计接口
export const handleRandomImgCount = async (request) => {
	const url = new URL(request.url);

	// 仅允许精确路径 /random-img-count，其他 URL 一律禁止；不返回错误详情
	if (url.pathname !== "/random-img-count" || url.search) {
		return new Response(null, { status: 403 });
	}

	const { folderMap, errorKey: folderMapErrorKey } = await getFolderMapFromKV();
	if (folderMapErrorKey) {
		return new Response(null, { status: 204 });
	}

	return jsonSuccessResponse(buildRandomImgCountData(folderMap));
};
