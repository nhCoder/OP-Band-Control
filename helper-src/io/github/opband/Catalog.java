package io.github.opband;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/** Official radio-band catalog printed in the CPH2747 OnePlus 15 Quick Guide. */
final class Catalog {
    static final String SOURCE =
            "OnePlus 15 CPH2747 Quick Guide (official Radio Waves Specifications)";
    static final String SOURCE_URL =
            "https://www.oneplus.com/content/dam/oneplus/2024/eu/store/safety_guide/OnePlus_15_Quick_Guide.pdf";

    static final int[] LTE = {
        1, 2, 3, 4, 5, 7, 8, 12, 13, 17, 18, 19, 20, 25, 26, 28, 30, 32,
        34, 38, 39, 40, 41, 42, 48, 66, 71
    };

    static final int[] NR = {
        1, 2, 3, 5, 7, 8, 12, 13, 20, 25, 26, 28, 30, 38, 40, 41, 48, 66,
        71, 75, 77, 78
    };

    static final Set<Integer> LTE_SET = asSet(LTE);
    static final Set<Integer> NR_SET = asSet(NR);

    private Catalog() {}

    private static Set<Integer> asSet(int[] values) {
        LinkedHashSet<Integer> set = new LinkedHashSet<>();
        for (int value : values) set.add(value);
        return Collections.unmodifiableSet(set);
    }
}
