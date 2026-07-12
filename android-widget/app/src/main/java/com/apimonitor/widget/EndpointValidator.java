package com.apimonitor.widget;

import android.net.Uri;

import java.net.InetAddress;
import java.util.Locale;

/** Validates the user-entered monitor origin and limits cleartext to private LAN hosts. */
final class EndpointValidator {
    private EndpointValidator() {
    }

    static String normalizeBaseUrl(String input) {
        if (input == null || input.trim().isEmpty()) {
            throw new IllegalArgumentException("请输入服务地址");
        }
        String value = input.trim();
        Uri uri = Uri.parse(value);
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null || host.trim().isEmpty()) {
            throw new IllegalArgumentException("地址需要包含 http:// 或 https://");
        }
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) {
            throw new IllegalArgumentException("只支持 HTTP(S) 地址");
        }
        if (uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("地址不能包含用户名、密码、查询参数或片段");
        }
        if (scheme.equals("http") && !isTrustedLanHost(host)) {
            throw new IllegalArgumentException("明文 HTTP 只允许本机或私有局域网地址");
        }

        String normalizedHost = host.toLowerCase(Locale.ROOT);
        if (normalizedHost.contains(":")) normalizedHost = "[" + normalizedHost + "]";
        StringBuilder result = new StringBuilder(scheme).append("://").append(normalizedHost);
        int port = uri.getPort();
        if (port != -1) result.append(':').append(port);
        String path = uri.getPath();
        if (path != null && !path.isEmpty() && !path.equals("/")) {
            result.append(path.replaceAll("/+$", ""));
        }
        return result.toString();
    }

    static boolean isTrustedLanHost(String host) {
        String value = host == null ? "" : host.toLowerCase(Locale.ROOT).trim();
        if (value.startsWith("[") && value.endsWith("]")) {
            value = value.substring(1, value.length() - 1);
        }
        if (value.equals("localhost") || value.endsWith(".local") || value.equals("::1")) return true;
        int[] octets = parseIpv4(value);
        if (octets != null) {
            return octets[0] == 10
                    || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                    || (octets[0] == 192 && octets[1] == 168)
                    || (octets[0] == 169 && octets[1] == 254)
                    || octets[0] == 127;
        }
        try {
            InetAddress address = InetAddress.getByName(value);
            return address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress();
        } catch (Exception ignored) {
            return false;
        }
    }

    private static int[] parseIpv4(String value) {
        String[] parts = value.split("\\.", -1);
        if (parts.length != 4) return null;
        int[] result = new int[4];
        try {
            for (int index = 0; index < 4; index++) {
                result[index] = Integer.parseInt(parts[index]);
                if (result[index] < 0 || result[index] > 255) return null;
            }
            return result;
        } catch (NumberFormatException ignored) {
            return null;
        }
    }
}
