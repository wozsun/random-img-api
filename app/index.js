import { getKvJsonObjectCached, getKvUrlCached } from "../utils/kv.js";
import { jsonErrorResponse } from "../utils/response.js";

// ===========================
// 随机图片 API 配置
// ===========================

// KV 命名空间与键名
const RANDOM_IMG_CONFIG_NAMESPACE = "random_img_config";
const FOLDER_MAP_KEY = "FOLDER_MAP";
const BASE_IMAGE_URL_KEY = "BASE_IMAGE_URL";

// 允许的查询参数：d=设备, b=亮度, t=主题, m=响应方式
const ALLOWED_PARAMS = ["d", "b", "t", "m"];
// 仅允许传入单个值的参数（主题 t 允许多值）
const SINGLE_VALUE_PARAMS = ["d", "b", "m"];
// folderMap 中的设备类型：pc=桌面端, mb=移动端
const MAP_DEVICES = ["pc", "mb"];
// 请求可接受的设备值：在 MAP_DEVICES 基础上增加 r = 强制随机
const REQUEST_DEVICES = [...MAP_DEVICES, "r"];
// 亮度类型：dark=暗色, light=亮色
const BRIGHTNESS_VALUES = ["dark", "light"];
// 可选响应方式：proxy=代理转发, redirect=302 重定向
const METHOD_VALUES = ["proxy", "redirect"];

// 代理模式下上游请求的最大重试次数
const FETCH_MAX_ATTEMPTS = 3;
// 重试间隔基数（毫秒），实际延迟 = 基数 × 当前重试次数
const FETCH_RETRY_DELAY_MS = 50;
// 代理模式下可重试的临时上游 HTTP 状态码
const RETRYABLE_UPSTREAM_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

// 默认响应方式
const DEFAULT_METHOD = "proxy";
// 是否允许使用 redirect 方式（关闭则强制 proxy）
const REDIRECT_ENABLED = true;

// 是否在 proxy 模式下返回 X-Image-Info 响应头（包含图片分组信息）
const IMAGE_INFO_HEADER_ENABLED = true;
// proxy 模式下 X-Image-Info 响应头的名称
const IMAGE_INFO_HEADER_NAME = "X-Image-Info";

// 图片文件名数字位数，如 6 → 000001.webp
const IMAGE_FILENAME_DIGITS = 6;
// 图片文件扩展名
const IMAGE_FILE_EXTENSION = ".webp";

// 将数组转为 Set，用于 O(1) 校验
const ALLOWED_PARAMS_SET = new Set(ALLOWED_PARAMS);
const SINGLE_VALUE_PARAMS_SET = new Set(SINGLE_VALUE_PARAMS);
const REQUEST_DEVICE_SET = new Set(REQUEST_DEVICES);
const BRIGHTNESS_SET = new Set(BRIGHTNESS_VALUES);
const METHOD_SET = new Set(METHOD_VALUES);

// ===========================
// 随机图片 API 错误定义
// ===========================
const ERRORS = {
	INVALID_QUERY_PARAMS: { status: 400, message: "Bad Request: Invalid query parameters" },
	DUPLICATE_PARAM: { status: 400, message: "Bad Request: Duplicate query parameter" },
	INVALID_DEVICE: { status: 400, message: "Bad Request: Invalid device" },
	INVALID_BRIGHTNESS: { status: 400, message: "Bad Request: Invalid brightness" },
	INVALID_THEME: { status: 400, message: "Bad Request: Invalid theme" },
	THEME_CONFLICT: { status: 400, message: "Bad Request: Cannot mix include and exclude theme selectors" },
	INVALID_METHOD: { status: 400, message: "Bad Request: Invalid method" },
	BASE_IMAGE_URL_CONFIG_ERROR: { status: 500, message: "Internal Server Error: BASE_IMAGE_URL is invalid or missing in KV" },
	FOLDER_MAP_CONFIG_ERROR: { status: 500, message: "Internal Server Error: FOLDER_MAP is invalid or missing in KV" },
	NO_IMAGES_FOR_COMBINATION: { status: 404, message: "Not Found: No available images for the selected filters" },
	NO_AVAILABLE_IMAGES: { status: 404, message: "Not Found: No available images" },
	UPSTREAM_BAD_STATUS: { status: 502, message: "Bad Gateway: Upstream image service responded with a non-success status" },
	UPSTREAM_FETCH_EXCEPTION: { status: 502, message: "Bad Gateway: Failed to reach upstream image service due to network/runtime exception" },
};

// 模块级主题缓存，通过 sourceRef 引用比较判断 folderMap 是否变更，避免重复构建
let validThemeCache = {
	themes: null,
	themeSet: null,
	sourceRef: null,
};

// 校验请求的查询参数是否均在允许列表内
const validateAllowedQueryParams = (params) => {
	for (const key of params.keys()) {
		if (!ALLOWED_PARAMS_SET.has(key)) {
			return jsonErrorResponse(ERRORS.INVALID_QUERY_PARAMS, {
				invalidParams: [key],
				allowedParams: ALLOWED_PARAMS,
			});
		}
	}
	return null;
};

// 校验仅允许单值的参数是否存在重复
const validateSingleValueParams = (params) => {
	for (const key of params.keys()) {
		if (SINGLE_VALUE_PARAMS_SET.has(key) && params.getAll(key).length > 1) {
			return jsonErrorResponse(ERRORS.DUPLICATE_PARAM, {
				field: key,
				hint: "This parameter only accepts a single value",
			});
		}
	}
	return null;
};

// 从 folderMap 中提取所有有效主题名列表
const buildValidThemes = (folderMap) =>
	Array.from(
		new Set(
			MAP_DEVICES.flatMap((device) =>
				Object.values(folderMap[device] ?? {}).flatMap((brightnessMap) =>
					Object.keys(brightnessMap ?? {})
				)
			)
		)
	);

// 确保 validThemeCache 与当前 folderMap 同步，必要时重建
const ensureValidThemeCache = (folderMap) => {
	// 引用未变化，直接返回缓存结果
	if (validThemeCache.themes && validThemeCache.sourceRef === folderMap) {
		return validThemeCache;
	}

	const themes = buildValidThemes(folderMap);
	validThemeCache = {
		themes,
		themeSet: new Set(themes),
		sourceRef: folderMap,
	};

	return validThemeCache;
};

// 根据 baseImageUrl 和所选文件夹信息构造随机图片 URL 及图片信息标识
const buildImageResult = (baseImageUrl, selectedFolder) => {
	const imageNumber = Math.floor(Math.random() * selectedFolder.count) + 1;
	const imageFilename = `${String(imageNumber).padStart(IMAGE_FILENAME_DIGITS, "0")}${IMAGE_FILE_EXTENSION}`;
	const url = `${baseImageUrl}${selectedFolder.device}-${selectedFolder.brightness}/${selectedFolder.theme}/${imageFilename}`;
	const imageInfo = `${selectedFolder.device}-${selectedFolder.brightness}-${selectedFolder.theme}-${imageNumber}`;
	return { url, imageInfo };
};

// 按照指定方式（proxy/redirect）响应图片请求
const respondImageByMethod = async (method, imageUrl, imageInfo) => {
	if (method === "redirect") {
		return new Response(null, {
			status: 302,
			headers: { Location: imageUrl },
		});
	}

	// proxy 模式：请求上游并透传响应，网络异常或临时 HTTP 状态失败时线性退避重试
	for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
		try {
			const upstreamResponse = await fetch(imageUrl);

			// 上游返回非 2xx 状态码：临时状态重试，其他状态立即返回错误
			if (!upstreamResponse.ok) {
				if (
					RETRYABLE_UPSTREAM_STATUS_CODES.has(upstreamResponse.status) &&
					attempt < FETCH_MAX_ATTEMPTS
				) {
					await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS * attempt));
					continue;
				}

				return jsonErrorResponse(ERRORS.UPSTREAM_BAD_STATUS, {
					upstreamStatus: upstreamResponse.status,
					hint: "Upstream responded but did not return a success status",
				});
			}

			const response = new Response(upstreamResponse.body, {
				status: upstreamResponse.status,
				headers: upstreamResponse.headers,
			});
			if (IMAGE_INFO_HEADER_ENABLED) {
				response.headers.set(IMAGE_INFO_HEADER_NAME, imageInfo);
			}
			return response;
		} catch {
			// 已耗尽重试次数，返回上游请求失败错误
			if (attempt >= FETCH_MAX_ATTEMPTS) {
				return jsonErrorResponse(ERRORS.UPSTREAM_FETCH_EXCEPTION, {
					hint: "Upstream request failed before receiving a valid response",
					retryAttempts: attempt,
				});
			}
			await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS * attempt));
		}
	}
};


// ===========================
// 随机图片主处理逻辑
// 处理随机图片请求：参数校验 -> 候选组合筛选 -> 加权抽样 -> redirect/proxy 返回
// ===========================
const handleRandomImg = async (request, env) => {
	// 仅允许 GET 请求，其余方法返回 405
	if (request.method !== "GET") {
		return jsonErrorResponse({ status: 405, message: "Method Not Allowed" });
	}

	let params;
	try {
		params = new URL(request.url).searchParams;
	} catch {
		return jsonErrorResponse({
			status: 400,
			message: "Bad Request: Request URL is malformed or cannot be parsed",
		}, {
			hint: "Ensure the request URL is valid and properly encoded",
		});
	}

	// 校验查询参数白名单，存在非法参数时直接返回错误
	const invalidParamsResponse = validateAllowedQueryParams(params);
	if (invalidParamsResponse) {
		return invalidParamsResponse;
	}

	// 校验单值参数不可重复，同一键只能出现一次
	const duplicateParamResponse = validateSingleValueParams(params);
	if (duplicateParamResponse) {
		return duplicateParamResponse;
	}

	// 解析响应方式
	const method = params.get("m")?.toLowerCase() || DEFAULT_METHOD;

	// 校验 method 参数：仅允许 proxy 或 redirect
	if (!METHOD_SET.has(method)) {
		return jsonErrorResponse(ERRORS.INVALID_METHOD, { field: "m" });
	}

	// 强制开关：若关闭 redirect，则无论参数如何都用 proxy
	const effectiveMethod = REDIRECT_ENABLED ? method : "proxy";

	const requestedDevice = params.get("d")?.toLowerCase() || null;
	// 校验设备参数合法性（允许 pc / mb / r）
	if (requestedDevice && !REQUEST_DEVICE_SET.has(requestedDevice)) {
		return jsonErrorResponse(ERRORS.INVALID_DEVICE, { field: "d" });
	}

	// 未指定设备时，根据 User-Agent 自动推断；无法识别则回退到随机
	let autoDevice = "r";
	if (!requestedDevice) {
		const userAgent = request.headers.get("User-Agent") || "";
		const isMobile = /Mobi|Android|iPhone/i.test(userAgent);
		const isDesktop = /Windows|Macintosh|Linux x86_64|X11/i.test(userAgent);
		autoDevice = isMobile ? "mb" : (isDesktop ? "pc" : "r");
	}
	const device = requestedDevice || autoDevice;
	// 构建设备候选列表："r" 展开为全部设备，否则仅用指定值
	const deviceCandidates =
		device === "r"
		? MAP_DEVICES
		: [device];

	// 读取亮度参数（若未传则为 null）
	const requestedBrightness = params.get("b")?.toLowerCase() || null;
	// 校验亮度参数合法性（允许 dark / light ）
	if (requestedBrightness && !BRIGHTNESS_SET.has(requestedBrightness)) {
		return jsonErrorResponse(ERRORS.INVALID_BRIGHTNESS, { field: "b" });
	}
	// 构建亮度候选列表：指定时仅用该值，否则使用全部亮度
	const brightnessCandidates = requestedBrightness ? [requestedBrightness] : BRIGHTNESS_VALUES;

	// 读取并归一化 theme 参数：支持多次传参与逗号分隔，最终统一小写并去重
	const rawThemeParams = Array.from(new Set(params
		.getAll("t")
		.flatMap((value) => value.split(","))
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean)));

	// 分离包含/排除主题："!theme" 为排除，其余为包含，两者不可混用
	const includeThemes = rawThemeParams.filter((v) => !v.startsWith("!"));
	const excludeThemes = rawThemeParams.filter((v) => v.startsWith("!")).map((v) => v.slice(1)).filter(Boolean);

	if (includeThemes.length > 0 && excludeThemes.length > 0) {
		return jsonErrorResponse(ERRORS.THEME_CONFLICT, {
			include: includeThemes,
			exclude: excludeThemes,
			hint: "Use either include themes (e.g. t=nature) or exclude themes (e.g. t=!nature), not both",
		});
	}

	// 并行获取 KV 配置：文件夹映射表 和 图片基础 URL
	const [folderMap, baseImageUrl] = await Promise.all([
		getKvJsonObjectCached({
			env,
			namespace: RANDOM_IMG_CONFIG_NAMESPACE,
			key: FOLDER_MAP_KEY,
			cacheKey: "random-img::folder-map",
		}),
		getKvUrlCached({
			env,
			namespace: RANDOM_IMG_CONFIG_NAMESPACE,
			key: BASE_IMAGE_URL_KEY,
			cacheKey: "random-img::base-image-url",
		}),
	]);
	if (!folderMap) {
		return jsonErrorResponse(ERRORS.FOLDER_MAP_CONFIG_ERROR);
	}
	if (!baseImageUrl) {
		return jsonErrorResponse(ERRORS.BASE_IMAGE_URL_CONFIG_ERROR);
	}

	// 校验用户指定的主题是否在 folderMap 中实际存在
	const themeCache = ensureValidThemeCache(folderMap);
	const allMentionedThemes = [...includeThemes, ...excludeThemes];

	if (allMentionedThemes.length > 0) {
		const invalidTheme = allMentionedThemes.find((t) => !themeCache.themeSet.has(t));
		if (invalidTheme) {
			return jsonErrorResponse(ERRORS.INVALID_THEME, { field: "t" });
		}
	}

	// 构建主题候选列表：有包含则直接用，有排除则从全量中过滤，均未指定则使用全部主题
	let themeCandidates;
	if (includeThemes.length > 0) {
		themeCandidates = includeThemes;
	} else if (excludeThemes.length > 0) {
		const excludeSet = new Set(excludeThemes);
		themeCandidates = themeCache.themes.filter((t) => !excludeSet.has(t));
	} else {
		themeCandidates = themeCache.themes;
	}

	// 遍历 设备×亮度×主题 的所有组合，收集图片数 > 0 的候选项
	const candidates = [];
	for (const candidateDevice of deviceCandidates) {
		const deviceMap = folderMap[candidateDevice] ?? {};
		for (const brightness of brightnessCandidates) {
			for (const theme of themeCandidates) {
				const count = Number(deviceMap?.[brightness]?.[theme] ?? 0);
				if (Number.isFinite(count) && count > 0) {
					candidates.push({ device: candidateDevice, brightness, theme, count });
				}
			}
		}
	}

	// 候选池为空时，根据是否指定了过滤条件返回不同的 404 错误
	const hasFilters = Boolean(
		requestedDevice ||
		requestedBrightness ||
		includeThemes.length > 0 ||
		excludeThemes.length > 0
	);
	if (candidates.length === 0) {
		if (hasFilters) {
			return jsonErrorResponse(ERRORS.NO_IMAGES_FOR_COMBINATION);
		}
		return jsonErrorResponse(ERRORS.NO_AVAILABLE_IMAGES, {
			hint: "Check FOLDER_MAP counts in KV to ensure at least one image count is greater than 0",
		});
	}

	// 加权随机抽样：以 count 为权重选取候选组合，使每张图片被选中的概率趋于均等
	let selectedFolder;
	if (candidates.length === 1) {
		selectedFolder = candidates[0];
	} else {
		const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.count, 0);
		// 总权重非法时兜底返回错误，避免随机逻辑异常
		if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
			return jsonErrorResponse(ERRORS.NO_AVAILABLE_IMAGES, {
				hint: "No valid weighted candidates available",
			});
		}
		// 在 [0, totalWeight) 区间取随机点，线性递减直到命中
		let remainingWeight = Math.random() * totalWeight;
		selectedFolder = null;
		for (const candidate of candidates) {
			remainingWeight -= candidate.count;
			if (remainingWeight < 0) {
				selectedFolder = candidate;
				break;
			}
		}
		// 浮点精度兜底：理论上不会触发，取最后一项作为保底
		if (!selectedFolder) {
			selectedFolder = candidates[candidates.length - 1];
		}
	}

	const { url: imageUrl, imageInfo } = buildImageResult(baseImageUrl, selectedFolder);
	return await respondImageByMethod(effectiveMethod, imageUrl, imageInfo);
};

// Worker 入口：根据路径分发至对应处理函数
export default {
	async fetch(request, env) {
		try {

			const url = new URL(request.url);
			if (url.pathname === "/random-img") {
				return await handleRandomImg(request, env);
			}

			return jsonErrorResponse({ status: 404, message: "API Not Found" });
		} catch (error) {
			console.error("Unhandled error in edge function:", error instanceof Error ? error.message : "unknown");
			return jsonErrorResponse({ status: 500, message: "Internal Server Error" });
		}
	},
};
