package io.github.opband;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Finite standards-level input policy for Android system-selection requests.
 *
 * <p>These identifiers are drawn from the E-UTRA and NR operating-band numbers
 * represented by Android API 35, with the standardized LTE supplemental-downlink
 * identifiers retained for guarded restore/selection compatibility. Membership
 * here only means that an input is structurally recognized. It does not claim
 * that the current phone, modem, antennas, carrier, or region supports a band.
 */
final class BandPolicy {
    static final String BASIS =
            "Finite LTE/NR operating-band identifier snapshot represented by Android API 35";

    static final int[] LTE_INPUTS = {
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
        17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
        33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48,
        49, 50, 51, 52, 53, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74,
        85, 87, 88
    };

    static final int[] NR_INPUTS = {
        1, 2, 3, 5, 7, 8, 12, 14, 18, 20, 25, 26, 28, 29, 30, 34,
        38, 39, 40, 41, 46, 48, 50, 51, 53, 65, 66, 70, 71, 74, 75, 76,
        77, 78, 79, 80, 81, 82, 83, 84, 86, 89, 90, 91, 92, 93, 94, 95,
        96, 257, 258, 260, 261
    };

    // One-way supplemental bands require another ordinary serving carrier. A
    // selection made entirely from SDL/SUL bands cannot provide standalone
    // service, even if it appears in Android's public operating-band constants.
    static final int[] LTE_SUPPLEMENTAL_DOWNLINK = {29, 32, 67, 69};
    static final int[] NR_SUPPLEMENTAL_DOWNLINK = {29, 75, 76};
    static final int[] NR_SUPPLEMENTAL_UPLINK = {80, 81, 82, 83, 84, 86, 89, 95};

    static final Set<Integer> LTE_INPUT_SET = asSet(LTE_INPUTS);
    static final Set<Integer> NR_INPUT_SET = asSet(NR_INPUTS);
    static final Set<Integer> LTE_SUPPLEMENTAL_DOWNLINK_SET =
            asSet(LTE_SUPPLEMENTAL_DOWNLINK);
    static final Set<Integer> NR_SUPPLEMENTAL_DOWNLINK_SET =
            asSet(NR_SUPPLEMENTAL_DOWNLINK);
    static final Set<Integer> NR_SUPPLEMENTAL_UPLINK_SET =
            asSet(NR_SUPPLEMENTAL_UPLINK);

    private BandPolicy() {}

    private static Set<Integer> asSet(int[] values) {
        LinkedHashSet<Integer> set = new LinkedHashSet<>();
        for (int value : values) set.add(value);
        return Collections.unmodifiableSet(set);
    }
}
