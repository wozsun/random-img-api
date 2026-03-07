#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import socket
import ssl
import time
import http.client
import urllib.parse
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value

# 关键运行/测试参数（规则变化时优先修改这里）。
# 统一配置环境变量名（JSON 字符串）。
CONFIG_ENV_NAME = "CONFIG"

# 单次 HTTP 请求超时时间（秒）。
TIMEOUT_SECONDS = 20.0
# 稳定性测试中随机重定向抽样次数。
RANDOM_RUNS = 30
# 瞬时网络/读取失败时的最大重试次数。
MAX_REQUEST_ATTEMPTS = 5
# 线性退避基数（sleep = base * attempt）。
RETRY_BACKOFF_BASE_SECONDS = 1

# 从统计结果筛选测试组合时允许的设备与亮度维度。
SUPPORTED_DEVICES = {"pc", "mb"}
SUPPORTED_BRIGHTNESS = {"dark", "light"}

# 一次完整测试中必须覆盖到的错误类型。
REQUIRED_ERROR_COVERAGE_KEYS = {
    "INVALID_QUERY_PARAMS",
    "INVALID_DEVICE",
    "INVALID_BRIGHTNESS",
    "INVALID_METHOD",
    "INVALID_THEME",
}
# 受数据分布影响、可能缺失的错误类型。
OPTIONAL_ERROR_COVERAGE_KEYS = {"NO_IMAGES_FOR_COMBINATION", "NO_AVAILABLE_IMAGES"}

def _normalize_asset_base_url(url: str) -> str:
    return url.rstrip("/") + "/"


def _required_config(raw_config: str) -> dict[str, Any]:
    try:
        parsed = json.loads(raw_config)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid CONFIG JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError("Invalid CONFIG JSON: root must be an object")
    return parsed


def _required_config_str(config: dict[str, Any], key: str) -> str:
    value = config.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"Missing or invalid CONFIG field: {key}")
    return value.strip()


def _config_bool(config: dict[str, Any], key: str, default: bool) -> bool:
    raw_value = config.get(key)
    if raw_value is None:
        return default
    if isinstance(raw_value, bool):
        return raw_value
    if isinstance(raw_value, (int, float)):
        return raw_value != 0
    if isinstance(raw_value, str):
        return raw_value.strip().lower() in {"1", "true", "yes", "on"}
    raise RuntimeError(f"Invalid boolean CONFIG field: {key}")


def _required_config_int(config: dict[str, Any], key: str) -> int:
    raw_value = config.get(key)
    if isinstance(raw_value, bool):
        raise RuntimeError(f"Invalid integer CONFIG field: {key}")
    if isinstance(raw_value, int):
        value = raw_value
    elif isinstance(raw_value, str) and raw_value.strip():
        try:
            value = int(raw_value.strip())
        except ValueError as exc:
            raise RuntimeError(f"Invalid integer CONFIG field: {key}") from exc
    else:
        raise RuntimeError(f"Missing or invalid CONFIG field: {key}")

    if value <= 0:
        raise RuntimeError(f"Invalid CONFIG field: {key} must be > 0")
    return value

def _mask_config_for_log(config_raw: str) -> str:
    """
    对 CONFIG_RAW 进行脱敏，只保留字段名和类型信息，不输出具体值。
    """
    try:
        parsed = json.loads(config_raw)
        if isinstance(parsed, dict):
            summary = {k: type(v).__name__ for k, v in parsed.items()}
            return f"<CONFIG fields: {summary}>"
        else:
            return "<CONFIG: not a dict>"
    except Exception:
        return "<CONFIG: invalid JSON>"

CONFIG_RAW = _required_env(CONFIG_ENV_NAME)
CONFIG = _required_config(CONFIG_RAW)

API_BASE_URL = _required_config_str(CONFIG, "API_BASE_URL")
ASSET_BASE_URL = _normalize_asset_base_url(_required_config_str(CONFIG, "ASSET_BASE_URL"))
RANDOM_IMG_COUNT_PATH = "/" + _required_config_str(CONFIG, "RANDOM_IMG_COUNT_PATH").strip("/")

IMAGE_FILENAME_DIGITS = _required_config_int(CONFIG, "IMAGE_FILENAME_DIGITS")
ENABLE_REDIRECT_TESTS = _config_bool(CONFIG, "ENABLE_REDIRECT_TESTS", False)
HIDDEN_ROUTE_QUERY_FORBIDDEN_MESSAGE_PART = "Routes do not accept query parameters"

SENSITIVE_LOG_TOKENS = sorted(
    {
        str(value).strip()
        for value in CONFIG.values()
        if isinstance(value, str) and str(value).strip()
    },
    key=len,
    reverse=True,
)

# 重定向地址格式校验正则（基于 ASSET_BASE_URL 做完整 URL 校验）。
REDIRECT_LOCATION_PATTERN = rf"^{re.escape(ASSET_BASE_URL)}(pc|mb)-(dark|light)/[a-z0-9_-]+/\d{{{IMAGE_FILENAME_DIGITS}}}\.webp$"


def _mask_url_for_log(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return "<invalid-url>"
    return "<redacted-url>"


def _redact_urls_in_text(text: str) -> str:
    value = str(text)

    for token in SENSITIVE_LOG_TOKENS:
        value = value.replace(token, "<redacted-value>")

    def _replace(match: re.Match[str]) -> str:
        return _mask_url_for_log(match.group(0))

    return re.sub(r"https?://[^\s'\"\]\[)>,]+", _replace, value)


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@dataclass
class HttpResult:
    status: int
    headers: dict[str, str]
    body: bytes

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


class ApiTester:
    def __init__(self, api_base_url: str, asset_base_url: str, timeout: float, random_runs: int) -> None:
        self.api_base_url = api_base_url.rstrip("/")
        self.asset_base_url = _normalize_asset_base_url(asset_base_url)
        self.timeout = timeout
        self.random_runs = random_runs
        self.error_coverage: dict[str, bool] = {
            "INVALID_QUERY_PARAMS": False,
            "INVALID_DEVICE": False,
            "INVALID_BRIGHTNESS": False,
            "INVALID_METHOD": False,
            "INVALID_THEME": False,
            "NO_IMAGES_FOR_COMBINATION": False,
            "NO_AVAILABLE_IMAGES": False,
        }
        self.passed = 0
        self.failed = 0
        self.failures: list[str] = []

        self.normal_opener = urllib.request.build_opener()
        self.no_redirect_opener = urllib.request.build_opener(NoRedirectHandler())

    def _url(self, path: str, query: dict[str, str] | None = None) -> str:
        if not path.startswith("/"):
            path = "/" + path
        if not query:
            return f"{self.api_base_url}{path}"
        return f"{self.api_base_url}{path}?{urllib.parse.urlencode(query)}"

    def request(self, path: str, query: dict[str, str] | None = None, follow_redirects: bool = True) -> HttpResult:
        url = self._url(path, query)
        req = urllib.request.Request(url, method="GET")
        opener = self.normal_opener if follow_redirects else self.no_redirect_opener

        max_attempts = MAX_REQUEST_ATTEMPTS
        for attempt in range(1, max_attempts + 1):
            try:
                with opener.open(req, timeout=self.timeout) as resp:
                    status = resp.getcode()
                    headers = {k.lower(): v for k, v in resp.headers.items()}
                    try:
                        body = resp.read()
                    except http.client.IncompleteRead as exc:
                        partial = bytes(exc.partial or b"")
                        if partial:
                            body = partial
                        elif attempt < max_attempts:
                            time.sleep(RETRY_BACKOFF_BASE_SECONDS * attempt)
                            continue
                        else:
                            raise
                    return HttpResult(
                        status=status,
                        headers=headers,
                        body=body,
                    )
            except urllib.error.HTTPError as exc:
                try:
                    error_body = exc.read()
                except http.client.IncompleteRead as read_exc:
                    error_body = bytes(read_exc.partial or b"")
                return HttpResult(
                    status=exc.code,
                    headers={k.lower(): v for k, v in exc.headers.items()},
                    body=error_body,
                )
            except (
                urllib.error.URLError,
                socket.timeout,
                TimeoutError,
                ssl.SSLError,
                http.client.IncompleteRead,
                http.client.RemoteDisconnected,
                ConnectionResetError,
                OSError,
            ) as exc:
                if attempt == max_attempts:
                    return HttpResult(
                        status=599,
                        headers={},
                        body=f"request failed after retries: {exc}".encode("utf-8", errors="replace"),
                    )
                time.sleep(RETRY_BACKOFF_BASE_SECONDS * attempt)

        return HttpResult(status=599, headers={}, body=b"request failed: unexpected retry flow")

    def assert_true(self, condition: bool, label: str, details: str = "") -> None:
        if condition:
            self.passed += 1
            print(f"[PASS] {label}")
            return

        self.failed += 1
        message = f"[FAIL] {label}"
        if details:
            message += f" | {_redact_urls_in_text(details)}"
        self.failures.append(message)
        print(message)

    def parse_json(self, result: HttpResult, label: str) -> Any:
        try:
            return json.loads(result.text)
        except json.JSONDecodeError as exc:
            self.assert_true(False, label, f"Invalid JSON: {exc}; body={_redact_urls_in_text(result.text[:200])}")
            return None

    def _mark_error_coverage(self, message: str) -> None:
        if "Invalid query parameters" in message:
            self.error_coverage["INVALID_QUERY_PARAMS"] = True
        elif "Invalid device" in message:
            self.error_coverage["INVALID_DEVICE"] = True
        elif "Invalid brightness" in message:
            self.error_coverage["INVALID_BRIGHTNESS"] = True
        elif "Invalid method" in message:
            self.error_coverage["INVALID_METHOD"] = True
        elif "Invalid theme" in message:
            self.error_coverage["INVALID_THEME"] = True
        elif "No available images for the selected filters" in message:
            self.error_coverage["NO_IMAGES_FOR_COMBINATION"] = True
        elif "No available images" in message:
            self.error_coverage["NO_AVAILABLE_IMAGES"] = True

    def _assert_error_json_payload(self, result: HttpResult, expected_status: int, label: str) -> dict[str, Any] | None:
        self.assert_true(
            "application/json" in result.headers.get("content-type", ""),
            f"{label} (content-type)",
            result.headers.get("content-type", ""),
        )
        payload = self.parse_json(result, f"{label} (json parse)")
        if not isinstance(payload, dict):
            return None
        self.assert_true(payload.get("status") == expected_status, f"{label} (payload status)", str(payload))
        message = payload.get("message")
        self.assert_true(isinstance(message, str) and bool(message.strip()), f"{label} (payload message)", str(payload))
        if isinstance(message, str):
            self._mark_error_coverage(message)
        return payload

    def expect_json_error(
        self,
        path: str,
        query: dict[str, str],
        expected_status: int,
        expected_message_part: str,
        label: str,
        expected_detail_keys: list[str] | None = None,
        expected_field: str | None = None,
        expected_received: str | None = None,
        expect_allowed_list: bool = False,
    ) -> None:
        result = self.request(path, query=query, follow_redirects=True)
        self.assert_true(result.status == expected_status, label, f"status={result.status}, expected={expected_status}")
        payload = self._assert_error_json_payload(result, expected_status, label)
        if not isinstance(payload, dict):
            return
        message = str(payload.get("message", ""))
        self.assert_true(expected_message_part in message, f"{label} (message)", f"message={message}")

        if expected_detail_keys is None and expected_field is None and expected_received is None and not expect_allowed_list:
            return

        details = payload.get("details")
        self.assert_true(isinstance(details, dict), f"{label} (details object)", str(payload))
        if not isinstance(details, dict):
            return

        if expected_detail_keys:
            for key in expected_detail_keys:
                self.assert_true(key in details, f"{label} (details.{key})", str(details))

        if expected_field is not None:
            self.assert_true(details.get("field") == expected_field, f"{label} (details.field)", str(details))

        if expected_received is not None:
            self.assert_true(str(details.get("received")) == expected_received, f"{label} (details.received)", str(details))

        if expect_allowed_list:
            allowed = details.get("allowed")
            self.assert_true(isinstance(allowed, list) and len(allowed) > 0, f"{label} (details.allowed)", str(details))

    def expect_empty_status(self, path: str, query: dict[str, str] | None, expected_status: int, label: str) -> None:
        result = self.request(path, query=query, follow_redirects=True)
        self.assert_true(result.status == expected_status, label, f"status={result.status}, expected={expected_status}")
        self.assert_true(len(result.body) == 0, f"{label} empty body", f"len={len(result.body)}")

    def assert_redirect_asset_base(self, location: str, label: str) -> None:
        if not location:
            self.assert_true(False, label, "empty location")
            return
        self.assert_true(
            location.startswith(self.asset_base_url),
            label,
            f"expected_prefix={self.asset_base_url}, location={location}",
        )

    def run(self) -> int:
        print(f"CONFIG env value: {_mask_config_for_log(CONFIG_RAW)}")
        print(f"Testing API base URL: {_mask_url_for_log(self.api_base_url)}")
        print(f"Expect asset base URL: {_mask_url_for_log(self.asset_base_url)} (strict=True)")
        print(f"Redirect tests enabled: {ENABLE_REDIRECT_TESTS}")
        started = time.time()

        # 1) 隐藏统计路由：读取 count 数据并校验结构
        count_resp = self.request(RANDOM_IMG_COUNT_PATH)
        self.assert_true(count_resp.status == 200, "GET hidden count route status")
        self.assert_true(
            "application/json" in count_resp.headers.get("content-type", ""),
            "GET hidden count route content-type",
            count_resp.headers.get("content-type", ""),
        )
        count_data = self.parse_json(count_resp, "GET hidden count route json")
        if not isinstance(count_data, dict):
            return 1

        required_keys = {"totalImages", "groupTotals", "themeTotals", "themeDetails"}
        self.assert_true(required_keys.issubset(set(count_data.keys())), "count json keys")

        group_totals = count_data.get("groupTotals", {})
        theme_totals = count_data.get("themeTotals", {})
        theme_details = count_data.get("themeDetails", [])

        self.assert_true(isinstance(group_totals, dict), "groupTotals is object")
        self.assert_true(isinstance(theme_totals, dict), "themeTotals is object")
        self.assert_true(isinstance(theme_details, list), "themeDetails is array")
        if not isinstance(group_totals, dict) or not isinstance(theme_totals, dict) or not isinstance(theme_details, list):
            return 1

        sum_group = sum(int(v) for v in group_totals.values())
        sum_theme = sum(int(v) for v in theme_totals.values())
        self.assert_true(sum_group == int(count_data.get("totalImages", -1)), "totalImages == sum(groupTotals)")
        self.assert_true(sum_theme == int(count_data.get("totalImages", -1)), "totalImages == sum(themeTotals)")

        normalized_theme_details: list[dict[str, Any]] = []
        detail_group_totals: dict[str, int] = {}
        detail_theme_totals: dict[str, int] = {}
        seen_detail_keys: set[tuple[str, str, str]] = set()

        for idx, row in enumerate(theme_details):
            row_label = f"themeDetails[{idx}]"
            self.assert_true(isinstance(row, dict), f"{row_label} is object", str(row))
            if not isinstance(row, dict):
                continue

            device = str(row.get("device", ""))
            brightness = str(row.get("brightness", ""))
            theme = str(row.get("theme", ""))
            raw_count = row.get("count", 0)

            self.assert_true(device in SUPPORTED_DEVICES, f"{row_label}.device", str(row))
            self.assert_true(brightness in SUPPORTED_BRIGHTNESS, f"{row_label}.brightness", str(row))
            self.assert_true(bool(theme), f"{row_label}.theme", str(row))

            try:
                count = int(raw_count)
            except (TypeError, ValueError):
                self.assert_true(False, f"{row_label}.count is int", str(row))
                continue

            self.assert_true(count >= 0, f"{row_label}.count >= 0", str(row))
            if device not in SUPPORTED_DEVICES or brightness not in SUPPORTED_BRIGHTNESS or not theme:
                continue

            combo_key = (device, brightness, theme)
            self.assert_true(combo_key not in seen_detail_keys, f"{row_label} unique combo", str(combo_key))
            if combo_key in seen_detail_keys:
                continue
            seen_detail_keys.add(combo_key)

            normalized_theme_details.append(
                {
                    "device": device,
                    "brightness": brightness,
                    "theme": theme,
                    "count": count,
                }
            )

            group_key = f"{device}-{brightness}"
            detail_group_totals[group_key] = detail_group_totals.get(group_key, 0) + count
            detail_theme_totals[theme] = detail_theme_totals.get(theme, 0) + count

        for group_key, total in group_totals.items():
            expected = detail_group_totals.get(str(group_key), 0)
            self.assert_true(
                int(total) == expected,
                f"groupTotals consistency {group_key}",
                f"groupTotals={total}, themeDetails={expected}",
            )

        for theme_key, total in theme_totals.items():
            expected = detail_theme_totals.get(str(theme_key), 0)
            self.assert_true(
                int(total) == expected,
                f"themeTotals consistency {theme_key}",
                f"themeTotals={total}, themeDetails={expected}",
            )

        self.expect_json_error(
            RANDOM_IMG_COUNT_PATH,
            {"x": "1"},
            403,
            HIDDEN_ROUTE_QUERY_FORBIDDEN_MESSAGE_PART,
            "hidden count route query forbidden",
        )

        # 2) 错误参数覆盖（仅 /random-img）
        self.expect_json_error(
            "/random-img",
            {"x": "1"},
            400,
            "Invalid query parameters",
            "invalid query key",
            expected_detail_keys=["invalidParams", "allowedParams"],
        )
        self.expect_json_error(
            "/random-img",
            {"d": "bad-device"},
            400,
            "Invalid device",
            "invalid device",
            expected_field="d",
            expected_received="bad-device",
            expect_allowed_list=True,
        )
        self.expect_json_error(
            "/random-img",
            {"b": "bad-brightness"},
            400,
            "Invalid brightness",
            "invalid brightness",
            expected_field="b",
            expected_received="bad-brightness",
            expect_allowed_list=True,
        )
        self.expect_json_error(
            "/random-img",
            {"m": "bad-method"},
            400,
            "Invalid method",
            "invalid method",
            expected_field="m",
            expected_received="bad-method",
            expect_allowed_list=True,
        )
        self.expect_json_error(
            "/random-img",
            {"t": "__nonexistent_theme__"},
            400,
            "Invalid theme",
            "invalid theme",
            expected_field="t",
            expected_received="__nonexistent_theme__",
            expect_allowed_list=True,
        )
        self.expect_json_error(
            "/random-img",
            {"m": "ReDiReCt", "x": "1"},
            400,
            "Invalid query parameters",
            "invalid query key has higher priority than method logic",
            expected_detail_keys=["invalidParams", "allowedParams"],
        )

        self.expect_json_error(
            "/random-img",
            {"x": "1", "d": "pc", "m": "redirect"},
            400,
            "Invalid query parameters",
            "invalid query still blocks valid known params",
            expected_detail_keys=["invalidParams", "allowedParams"],
        )

        self.expect_json_error(
            "/random-img",
            {"d": "bad-device", "m": "bad-method"},
            400,
            "Invalid method",
            "invalid method has priority over device/brightness/theme",
            expected_field="m",
            expected_received="bad-method",
            expect_allowed_list=True,
        )

        # 3) 大小写兼容
        if ENABLE_REDIRECT_TESTS:
            mixed_case_method = self.request("/random-img", query={"m": "ReDiReCt"}, follow_redirects=False)
            self.assert_true(mixed_case_method.status == 302, "mixed-case method redirect status", f"status={mixed_case_method.status}")

            mixed_case_device_brightness = self.request(
                "/random-img",
                query={"d": "PC", "b": "LiGhT", "m": "redirect"},
                follow_redirects=False,
            )
            self.assert_true(
                mixed_case_device_brightness.status in {302, 404},
                "mixed-case device/brightness status",
                f"status={mixed_case_device_brightness.status}",
            )
        else:
            mixed_case_proxy = self.request(
                "/random-img",
                query={"d": "PC", "b": "LiGhT", "m": "PrOxY"},
                follow_redirects=True,
            )
            self.assert_true(
                mixed_case_proxy.status in {200, 404, 502},
                "mixed-case device/brightness proxy status",
                f"status={mixed_case_proxy.status}",
            )

        # 4) 默认请求（proxy）
        default_img = self.request("/random-img")
        self.assert_true(default_img.status in {200, 404, 502}, "GET /random-img default status", f"status={default_img.status}")
        if default_img.status == 200:
            self.assert_true(
                "application/json" not in default_img.headers.get("content-type", ""),
                "GET /random-img default content-type not json",
                default_img.headers.get("content-type", ""),
            )
            self.assert_true(len(default_img.body) > 0, "GET /random-img default body non-empty")
        else:
            self._assert_error_json_payload(default_img, default_img.status, "GET /random-img default error payload")

        # 5) 基于统计数据做组合覆盖
        nonzero_details = [row for row in normalized_theme_details if int(row["count"]) > 0]
        zero_details = [row for row in normalized_theme_details if int(row["count"]) == 0]

        self.assert_true(len(nonzero_details) > 0, "there is at least one nonzero combination")

        for device in sorted(SUPPORTED_DEVICES):
            for brightness in sorted(SUPPORTED_BRIGHTNESS):
                group_key = f"{device}-{brightness}"
                group_count = int(group_totals.get(group_key, 0))
                if group_count > 0:
                    if ENABLE_REDIRECT_TESTS:
                        group_redirect = self.request(
                            "/random-img",
                            query={"d": device, "b": brightness, "m": "redirect"},
                            follow_redirects=False,
                        )
                        self.assert_true(
                            group_redirect.status == 302,
                            f"group {group_key} redirect status",
                            f"status={group_redirect.status}",
                        )
                    else:
                        group_proxy = self.request(
                            "/random-img",
                            query={"d": device, "b": brightness},
                            follow_redirects=True,
                        )
                        self.assert_true(
                            group_proxy.status == 200,
                            f"group {group_key} proxy status",
                            f"status={group_proxy.status}",
                        )
                else:
                    self.expect_json_error(
                        "/random-img",
                        {"d": device, "b": brightness},
                        404,
                        "No available images for the selected filters",
                        f"group {group_key} has no images",
                    )

        # 6) 有效参数组合（只断言不返回 400）
        valid_queries = [
            {"d": "pc"},
            {"d": "mb"},
            {"d": "r"},
            {"b": "dark"},
            {"b": "light"},
            {"d": "pc", "b": "dark"},
            {"d": "mb", "b": "light"},
            {"d": "r", "b": "dark"},
            {"m": "proxy"},
        ]
        for idx, query in enumerate(valid_queries, start=1):
            result = self.request("/random-img", query=query, follow_redirects=True)
            self.assert_true(
                result.status in {200, 404, 502},
                f"valid query #{idx} status",
                f"query={query}, status={result.status}",
            )
            if result.status != 200:
                self._assert_error_json_payload(result, result.status, f"valid query #{idx} error payload")

        # 7) 多主题参数覆盖（使用统计结果中同组多个可用主题）
        themes_by_group: dict[tuple[str, str], list[str]] = {}
        for row in nonzero_details:
            d = str(row["device"])
            b = str(row["brightness"])
            t = str(row["theme"])
            themes_by_group.setdefault((d, b), []).append(t)

        multi_theme_group = next(
            (
                (d, b, sorted(set(themes)))
                for (d, b), themes in themes_by_group.items()
                if len(set(themes)) >= 2
            ),
            None,
        )

        if multi_theme_group:
            d, b, themes = multi_theme_group
            t1, t2 = themes[0], themes[1]

            if ENABLE_REDIRECT_TESTS:
                multi_csv = self.request(
                    "/random-img",
                    query={"d": d, "b": b, "t": f"{t1},{t2}", "m": "redirect"},
                    follow_redirects=False,
                )
                self.assert_true(multi_csv.status == 302, "multi-theme csv redirect status", f"status={multi_csv.status}")
            else:
                multi_csv = self.request(
                    "/random-img",
                    query={"d": d, "b": b, "t": f"{t1},{t2}"},
                    follow_redirects=True,
                )
                self.assert_true(multi_csv.status == 200, "multi-theme csv proxy status", f"status={multi_csv.status}")

            self.expect_json_error(
                "/random-img",
                {"d": d, "b": b, "t": f"{t1},__nonexistent_theme__"},
                400,
                "Invalid theme",
                "multi-theme csv with invalid theme",
            )
        else:
            print("[SKIP] 不存在同 device+brightness 下至少 2 个可用主题，跳过多主题断言")

        # 8) 每个有图组合至少测一次
        for row in nonzero_details:
            d, b, t = str(row["device"]), str(row["brightness"]), str(row["theme"])
            label_prefix = f"combo {d}-{b}-{t}"

            if ENABLE_REDIRECT_TESTS:
                rr = self.request("/random-img", query={"d": d, "b": b, "t": t, "m": "redirect"}, follow_redirects=False)
                self.assert_true(rr.status == 302, f"{label_prefix} redirect status", f"status={rr.status}")
            rp = self.request("/random-img", query={"d": d, "b": b, "t": t, "m": "proxy"}, follow_redirects=True)
            self.assert_true(rp.status == 200, f"{label_prefix} proxy status", f"status={rp.status}")

        if zero_details:
            row = zero_details[0]
            d, b, t = str(row["device"]), str(row["brightness"]), str(row["theme"])
            self.expect_json_error(
                "/random-img",
                {"d": d, "b": b, "t": t},
                404,
                "No available images for the selected filters",
                f"no images for combination {d}-{b}-{t}",
            )

        # 9) 重定向模式
        if ENABLE_REDIRECT_TESTS:
            redirect_any = self.request("/random-img", query={"m": "redirect"}, follow_redirects=False)
            self.assert_true(redirect_any.status == 302, "GET /random-img?m=redirect status")
            location = redirect_any.headers.get("location", "")
            self.assert_true(bool(location), "GET /random-img?m=redirect location present")
            self.assert_true(len(redirect_any.body) == 0, "GET /random-img?m=redirect empty body", f"len={len(redirect_any.body)}")
            self.assert_redirect_asset_base(location, "GET /random-img?m=redirect asset base match")
            self.assert_true(
                bool(re.search(REDIRECT_LOCATION_PATTERN, location)),
                "GET /random-img?m=redirect location format",
                location,
            )

            redirect_with_filters = self.request(
                "/random-img",
                query={"d": "r", "b": "dark", "m": "redirect"},
                follow_redirects=False,
            )
            self.assert_true(
                redirect_with_filters.status in {302, 404},
                "GET /random-img?d=r&b=dark&m=redirect status",
                f"status={redirect_with_filters.status}",
            )
        else:
            print("[SKIP] 已关闭 redirect 测试，跳过 m=redirect 行为断言")

        # 10) 稳定性抽样
        if ENABLE_REDIRECT_TESTS:
            for i in range(self.random_runs):
                r = self.request("/random-img", query={"m": "redirect"}, follow_redirects=False)
                self.assert_true(r.status == 302, f"random stability redirect #{i + 1}", f"status={r.status}")
        else:
            for i in range(self.random_runs):
                r = self.request("/random-img", query={"m": "proxy"}, follow_redirects=True)
                self.assert_true(
                    r.status in {200, 404, 502},
                    f"random stability proxy #{i + 1}",
                    f"status={r.status}",
                )

        missing_hard = sorted(k for k in REQUIRED_ERROR_COVERAGE_KEYS if not self.error_coverage.get(k, False))
        missing_optional = sorted(k for k in OPTIONAL_ERROR_COVERAGE_KEYS if not self.error_coverage.get(k, False))

        self.assert_true(len(missing_hard) == 0, "hard error coverage complete", f"missing={missing_hard}")
        if missing_optional:
            print(f"[INFO] optional error coverage missing (data-dependent): {', '.join(missing_optional)}")

        elapsed = time.time() - started
        print("\n========== 测试结果 ==========")
        print(f"Passed: {self.passed}")
        print(f"Failed: {self.failed}")
        print(f"Elapsed: {elapsed:.2f}s")

        if self.failures:
            print("\n失败详情：")
            for item in self.failures:
                print(item)
            return 1

        print("全部通过 ✅")
        return 0


def main() -> None:
    tester = ApiTester(
        api_base_url=API_BASE_URL,
        asset_base_url=ASSET_BASE_URL,
        timeout=TIMEOUT_SECONDS,
        random_runs=RANDOM_RUNS,
    )
    code = tester.run()
    raise SystemExit(code)


if __name__ == "__main__":
    main()
