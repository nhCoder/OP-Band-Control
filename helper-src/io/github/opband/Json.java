package io.github.opband;

import java.io.IOException;
import java.util.Collection;
import java.util.Map;

final class Json {
    private Json() {}

    static String encode(Object value) throws IOException {
        StringBuilder output = new StringBuilder(1024);
        write(output, value);
        return output.toString();
    }

    @SuppressWarnings("unchecked")
    private static void write(StringBuilder output, Object value) throws IOException {
        if (value == null) {
            output.append("null");
        } else if (value instanceof Boolean) {
            output.append(Boolean.TRUE.equals(value) ? "true" : "false");
        } else if (value instanceof Number) {
            Number number = (Number) value;
            if (number instanceof Double && !Double.isFinite(number.doubleValue())) {
                output.append("null");
            } else if (number instanceof Float && !Float.isFinite(number.floatValue())) {
                output.append("null");
            } else {
                output.append(number);
            }
        } else if (value instanceof String || value instanceof Character) {
            string(output, String.valueOf(value));
        } else if (value instanceof Map) {
            output.append('{');
            boolean first = true;
            for (Map.Entry<Object, Object> entry : ((Map<Object, Object>) value).entrySet()) {
                if (!first) output.append(',');
                first = false;
                string(output, String.valueOf(entry.getKey()));
                output.append(':');
                write(output, entry.getValue());
            }
            output.append('}');
        } else if (value instanceof Collection) {
            output.append('[');
            boolean first = true;
            for (Object item : (Collection<?>) value) {
                if (!first) output.append(',');
                first = false;
                write(output, item);
            }
            output.append(']');
        } else if (value.getClass().isArray()) {
            output.append('[');
            if (value instanceof int[]) {
                int[] items = (int[]) value;
                for (int i = 0; i < items.length; i++) {
                    if (i > 0) output.append(',');
                    output.append(items[i]);
                }
            } else if (value instanceof Object[]) {
                Object[] items = (Object[]) value;
                for (int i = 0; i < items.length; i++) {
                    if (i > 0) output.append(',');
                    write(output, items[i]);
                }
            } else {
                throw new IllegalArgumentException("Unsupported JSON array type");
            }
            output.append(']');
        } else {
            string(output, String.valueOf(value));
        }
    }

    private static void string(StringBuilder output, String value) {
        output.append('"');
        for (int i = 0; i < value.length(); i++) {
            char character = value.charAt(i);
            switch (character) {
                case '"': output.append("\\\""); break;
                case '\\': output.append("\\\\"); break;
                case '\b': output.append("\\b"); break;
                case '\f': output.append("\\f"); break;
                case '\n': output.append("\\n"); break;
                case '\r': output.append("\\r"); break;
                case '\t': output.append("\\t"); break;
                default:
                    if (character < 0x20) {
                        output.append("\\u00");
                        int high = (character >> 4) & 0x0f;
                        int low = character & 0x0f;
                        output.append(Character.forDigit(high, 16));
                        output.append(Character.forDigit(low, 16));
                    } else {
                        output.append(character);
                    }
            }
        }
        output.append('"');
    }
}
