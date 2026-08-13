package io.github.opband;

import android.content.Context;
import android.os.Build;
import android.telephony.AccessNetworkConstants;
import android.telephony.CellIdentity;
import android.telephony.CellIdentityLte;
import android.telephony.CellIdentityNr;
import android.telephony.CellInfo;
import android.telephony.CellInfoLte;
import android.telephony.CellInfoNr;
import android.telephony.CellSignalStrengthLte;
import android.telephony.CellSignalStrengthNr;
import android.telephony.PhysicalChannelConfig;
import android.telephony.RadioAccessSpecifier;
import android.telephony.NetworkRegistrationInfo;
import android.telephony.ServiceState;
import android.telephony.SignalStrength;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyCallback;
import android.telephony.TelephonyManager;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

final class TelephonyBackend {
    private static final int RAN_EUTRAN = 3;
    private static final int RAN_NGRAN = 6;
    private static final int CALLBACK_TIMEOUT_SECONDS = 10;
    private static final int PHYSICAL_CHANNEL_WAIT_MILLIS = 1800;

    private static final Executor DIRECT_EXECUTOR = new Executor() {
        @Override public void execute(Runnable command) { command.run(); }
    };

    private final TelephonyManager baseTelephony;
    private final SubscriptionManager subscriptions;

    TelephonyBackend(Context context) {
        this.baseTelephony = context.getSystemService(TelephonyManager.class);
        this.subscriptions = context.getSystemService(SubscriptionManager.class);
        if (baseTelephony == null || subscriptions == null) {
            throw new IllegalStateException("Android telephony services are unavailable");
        }
    }

    Map<String, Object> status(Integer requestedSubId) throws Exception {
        SubscriptionSnapshot subscriptionSnapshot = readSubscriptions();
        Integer selectedSubId = resolveSubId(requestedSubId, subscriptionSnapshot, true);
        boolean selectedVerified = selectedSubId != null
                && subscriptionSnapshot.activeIds.contains(selectedSubId);
        boolean selectedWriteVerified = selectedSubId != null
                && subscriptionSnapshot.writeVerifiedIds.contains(selectedSubId);

        Map<String, Object> root = new LinkedHashMap<>();
        root.put("ok", true);
        root.put("timestamp", System.currentTimeMillis());
        root.put("device", device());
        root.put("subscriptions", subscriptionSnapshot.json);
        root.put("selectedSubId", selectedSubId);

        // Even when an OEM subscription service returns no IDs, the base manager can
        // still expose current cells, PCCs, data state, and sometimes selection state.
        // It is deliberately monitoring-only until a subscription is verified active.
        TelephonyManager telephony = selectedVerified
                ? baseTelephony.createForSubscriptionId(selectedSubId)
                : baseTelephony;
        String monitoringScope = selectedVerified ? "subscription" : "base";
        List<RadioAccessSpecifier> specifiers = null;
        String selectionError = null;
        if (telephony != null) {
            try {
                specifiers = getSelection(telephony);
            } catch (Throwable error) {
                selectionError = safeError(error);
            }
        }

        LiveRadio live = readLiveRadio(telephony);
        int dataState = TelephonyManager.DATA_UNKNOWN;
        int dataNetworkType = TelephonyManager.NETWORK_TYPE_UNKNOWN;
        int voiceNetworkType = TelephonyManager.NETWORK_TYPE_UNKNOWN;
        ServiceState serviceState = null;
        Integer overallSignalLevel = null;
        boolean dataStateRead = false;
        boolean dataNetworkTypeRead = false;
        boolean voiceNetworkTypeRead = false;
        boolean serviceStateRead = false;
        boolean signalStrengthRead = false;
        String dataStateError = null;
        String dataNetworkTypeError = null;
        String voiceNetworkTypeError = null;
        String serviceStateError = null;
        String signalStrengthError = null;
        try {
            dataState = telephony.getDataState();
            dataStateRead = true;
        } catch (Throwable error) {
            dataStateError = safeError(error);
        }
        try {
            dataNetworkType = telephony.getDataNetworkType();
            dataNetworkTypeRead = true;
        } catch (Throwable error) {
            dataNetworkTypeError = safeError(error);
        }
        try {
            voiceNetworkType = telephony.getVoiceNetworkType();
            voiceNetworkTypeRead = true;
        } catch (Throwable error) {
            voiceNetworkTypeError = safeError(error);
        }
        try {
            serviceState = telephony.getServiceState();
            serviceStateRead = serviceState != null;
        } catch (Throwable error) {
            serviceStateError = safeError(error);
        }
        try {
            SignalStrength signalStrength = telephony.getSignalStrength();
            if (signalStrength != null) {
                overallSignalLevel = signalLevelValue(signalStrength.getLevel());
                signalStrengthRead = overallSignalLevel != null;
            }
        } catch (Throwable error) {
            signalStrengthError = safeError(error);
        }
        if (serviceStateRead) addServiceStateCells(live, serviceState);
        boolean inService = serviceStateRead
                && serviceState.getState() == ServiceState.STATE_IN_SERVICE;
        boolean connected = dataState == TelephonyManager.DATA_CONNECTED
                || inService
                || !live.serving.isEmpty();
        int effectiveNetworkType = dataNetworkType != TelephonyManager.NETWORK_TYPE_UNKNOWN
                ? dataNetworkType : voiceNetworkType;
        boolean carrierAggregationActive = live.physicalLtePrimaryCount > 0
                && live.physicalLteSecondaryCount > 0;
        String carrierAggregationState = live.physicalReadSucceeded
                ? (carrierAggregationActive ? "active" : "inactive")
                : "unknown";
        root.put("connected", connected);
        root.put("mode", mode(
                live.serving, effectiveNetworkType, connected, carrierAggregationActive));
        root.put("carrierAggregationActive", carrierAggregationActive);
        root.put("carrierAggregationState", carrierAggregationState);
        root.put("signalLevel", overallSignalLevel);
        root.put("serving", live.serving);

        BandDiscovery bandDiscovery = discoverBands(live, specifiers);
        Map<String, Object> observed = new LinkedHashMap<>();
        observed.put("lte", new ArrayList<>(live.observedLte));
        observed.put("nr", new ArrayList<>(live.observedNr));
        root.put("observed", observed);
        root.put("discoveredBands", bandDiscovery.json());
        // Keep catalog as a compatibility view for existing WebUIs. Unlike the
        // old device-specific list, it contains only bands discovered at runtime.
        root.put("catalog", bandDiscovery.catalogJson());
        root.put("inputPolicy", inputPolicy());
        root.put("selection", selectionJson(specifiers));
        boolean telemetryRead = live.cellReadSucceeded || live.physicalReadSucceeded
                || dataStateRead || dataNetworkTypeRead || voiceNetworkTypeRead
                || serviceStateRead || signalStrengthRead;
        root.put("capability", capability(
                telephony,
                telemetryRead,
                specifiers != null,
                selectionError,
                selectedWriteVerified,
                monitoringScope));

        subscriptionSnapshot.diagnostics.put("requestedSubId", requestedSubId);
        subscriptionSnapshot.diagnostics.put("selectedSubId", selectedSubId);
        subscriptionSnapshot.diagnostics.put("selectedVerifiedActive", selectedVerified);
        subscriptionSnapshot.diagnostics.put("selectedWriteVerified", selectedWriteVerified);
        subscriptionSnapshot.diagnostics.put("monitoringScope", monitoringScope);
        root.put("subscriptionDiagnostics", subscriptionSnapshot.diagnostics);

        Map<String, Object> telemetryDiagnostics = new LinkedHashMap<>();
        telemetryDiagnostics.put("scope", monitoringScope);
        telemetryDiagnostics.put("cellInfoRead", live.cellReadSucceeded);
        telemetryDiagnostics.put("physicalChannelRead", live.physicalReadSucceeded);
        telemetryDiagnostics.put("dataStateRead", dataStateRead);
        telemetryDiagnostics.put("dataNetworkTypeRead", dataNetworkTypeRead);
        telemetryDiagnostics.put("voiceNetworkTypeRead", voiceNetworkTypeRead);
        telemetryDiagnostics.put("serviceStateRead", serviceStateRead);
        telemetryDiagnostics.put("signalStrengthRead", signalStrengthRead);
        telemetryDiagnostics.put("dataState", dataStateRead ? dataState : null);
        telemetryDiagnostics.put("dataNetworkType", dataNetworkTypeRead ? dataNetworkType : null);
        telemetryDiagnostics.put("voiceNetworkType", voiceNetworkTypeRead ? voiceNetworkType : null);
        telemetryDiagnostics.put("serviceState",
                serviceStateRead ? serviceState.getState() : null);
        telemetryDiagnostics.put("signalLevel", overallSignalLevel);
        telemetryDiagnostics.put("physicalLteCarrierCount", live.physicalLteCarrierKeys.size());
        telemetryDiagnostics.put("physicalLtePrimaryCount", live.physicalLtePrimaryCount);
        telemetryDiagnostics.put("physicalLteSecondaryCount", live.physicalLteSecondaryCount);
        telemetryDiagnostics.put("carrierAggregationState", carrierAggregationState);
        telemetryDiagnostics.put("carrierAggregationActive", carrierAggregationActive);
        telemetryDiagnostics.put("inService", inService);
        if (dataStateError != null) telemetryDiagnostics.put("dataStateError", dataStateError);
        if (dataNetworkTypeError != null) {
            telemetryDiagnostics.put("dataNetworkTypeError", dataNetworkTypeError);
        }
        if (voiceNetworkTypeError != null) {
            telemetryDiagnostics.put("voiceNetworkTypeError", voiceNetworkTypeError);
        }
        if (serviceStateError != null) {
            telemetryDiagnostics.put("serviceStateError", serviceStateError);
        }
        if (signalStrengthError != null) {
            telemetryDiagnostics.put("signalStrengthError", signalStrengthError);
        }
        root.put("telemetryDiagnostics", telemetryDiagnostics);

        // Extra diagnostic fields preserve the unmerged Android API reports.
        root.put("cells", live.cells);
        root.put("physicalChannels", live.physicalChannels);
        if (subscriptionSnapshot.error != null) {
            root.put("subscriptionError", subscriptionSnapshot.error);
        }
        if (live.cellError != null) root.put("cellInfoError", live.cellError);
        if (live.physicalError != null) root.put("physicalChannelError", live.physicalError);
        if (selectionError != null) root.put("selectionError", selectionError);
        return root;
    }

    Map<String, Object> selection(Integer requestedSubId) throws Exception {
        SubscriptionSnapshot snapshot = readSubscriptions();
        int subId = requireSubId(requestedSubId, snapshot);
        List<RadioAccessSpecifier> specifiers =
                getSelection(baseTelephony.createForSubscriptionId(subId));

        Map<String, Object> root = new LinkedHashMap<>();
        root.put("ok", true);
        root.put("timestamp", System.currentTimeMillis());
        root.put("subId", subId);
        root.put("selection", selectionJson(specifiers));
        root.put("restoreToken", encodeRestoreToken(specifiers));
        return root;
    }

    Map<String, Object> apply(Integer requestedSubId, String lteCsv, String nrCsv)
            throws Exception {
        SubscriptionSnapshot snapshot = readSubscriptions();
        int subId = requireSubId(requestedSubId, snapshot);
        int[] lte = parseInputBands(lteCsv, BandPolicy.LTE_INPUT_SET, "LTE");
        int[] nr = parseInputBands(nrCsv, BandPolicy.NR_INPUT_SET, "NR");
        if (lte.length == 0 && nr.length == 0) {
            throw commandError(
                    "EMPTY_SELECTION_REQUIRES_RESET",
                    "An empty selection is only permitted through reset",
                    65);
        }
        if (!hasOrdinaryServingBand(lte, nr)) {
            throw commandError(
                    "UNSAFE_SUPPLEMENTAL_ONLY",
                    "A selection made only from supplemental downlink/uplink bands "
                            + "cannot provide standalone service",
                    65);
        }

        List<RadioAccessSpecifier> requested = new ArrayList<>();
        if (lte.length > 0) requested.add(new RadioAccessSpecifier(RAN_EUTRAN, lte, new int[0]));
        if (nr.length > 0) requested.add(new RadioAccessSpecifier(RAN_NGRAN, nr, new int[0]));
        TelephonyManager telephony = baseTelephony.createForSubscriptionId(subId);
        getSelection(telephony);
        assertActiveNow(subId);
        setSelection(telephony, requested);
        List<RadioAccessSpecifier> confirmed = getSelectionBestEffort(telephony, requested);
        return mutationResult("apply", subId, confirmed);
    }

    Map<String, Object> reset(Integer requestedSubId) throws Exception {
        SubscriptionSnapshot snapshot = readSubscriptions();
        int subId = requireSubId(requestedSubId, snapshot);
        TelephonyManager telephony = baseTelephony.createForSubscriptionId(subId);
        List<RadioAccessSpecifier> current = getSelection(telephony);
        if (current.isEmpty()) {
            return resetResult(subId, current, false);
        }
        assertActiveNow(subId);
        setSelection(telephony, Collections.<RadioAccessSpecifier>emptyList());
        List<RadioAccessSpecifier> confirmed =
                getSelectionBestEffort(telephony, Collections.<RadioAccessSpecifier>emptyList());
        return resetResult(subId, confirmed, true);
    }

    private Map<String, Object> resetResult(
            int subId, List<RadioAccessSpecifier> specifiers, boolean changed) {
        Map<String, Object> root = mutationResult("reset", subId, specifiers);
        root.put("changed", changed);
        root.put("noOp", !changed);
        return root;
    }

    Map<String, Object> restore(Integer requestedSubId, String token) throws Exception {
        SubscriptionSnapshot snapshot = readSubscriptions();
        int subId = requireSubId(requestedSubId, snapshot);
        List<RadioAccessSpecifier> specifiers = decodeRestoreToken(token);
        TelephonyManager telephony = baseTelephony.createForSubscriptionId(subId);
        List<RadioAccessSpecifier> current = getSelection(telephony);
        if (encodeRestoreToken(current).equals(encodeRestoreToken(specifiers))) {
            return restoreResult(subId, current, false);
        }
        assertActiveNow(subId);
        setSelection(telephony, specifiers);
        List<RadioAccessSpecifier> confirmed = getSelectionBestEffort(telephony, specifiers);
        return restoreResult(subId, confirmed, true);
    }

    private Map<String, Object> restoreResult(
            int subId, List<RadioAccessSpecifier> specifiers, boolean changed) {
        Map<String, Object> root = mutationResult("restore", subId, specifiers);
        root.put("changed", changed);
        root.put("noOp", !changed);
        return root;
    }

    private Map<String, Object> mutationResult(
            String operation, int subId, List<RadioAccessSpecifier> specifiers) {
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("ok", true);
        root.put("timestamp", System.currentTimeMillis());
        root.put("operation", operation);
        root.put("subId", subId);
        root.put("selection", selectionJson(specifiers));
        root.put("restoreToken", encodeRestoreToken(specifiers));
        return root;
    }

    @SuppressWarnings("deprecation")
    private SubscriptionSnapshot readSubscriptions() {
        SubscriptionSnapshot snapshot = new SubscriptionSnapshot();

        snapshot.defaultDataSubId = readStaticSubId(
                snapshot, "getDefaultDataSubscriptionId",
                new SubIdReader() {
                    @Override public int read() {
                        return SubscriptionManager.getDefaultDataSubscriptionId();
                    }
                });
        snapshot.activeDataSubId = readStaticSubId(
                snapshot, "getActiveDataSubscriptionId",
                new SubIdReader() {
                    @Override public int read() {
                        return SubscriptionManager.getActiveDataSubscriptionId();
                    }
                });
        snapshot.defaultSubId = readStaticSubId(
                snapshot, "getDefaultSubscriptionId",
                new SubIdReader() {
                    @Override public int read() {
                        return SubscriptionManager.getDefaultSubscriptionId();
                    }
                });
        snapshot.defaultVoiceSubId = readStaticSubId(
                snapshot, "getDefaultVoiceSubscriptionId",
                new SubIdReader() {
                    @Override public int read() {
                        return SubscriptionManager.getDefaultVoiceSubscriptionId();
                    }
                });
        snapshot.defaultSmsSubId = readStaticSubId(
                snapshot, "getDefaultSmsSubscriptionId",
                new SubIdReader() {
                    @Override public int read() {
                        return SubscriptionManager.getDefaultSmsSubscriptionId();
                    }
                });
        try {
            snapshot.baseTelephonySubId = baseTelephony.getSubscriptionId();
            recordAttempt(snapshot, "TelephonyManager.getSubscriptionId", true, 1, null);
        } catch (Throwable error) {
            snapshot.baseTelephonySubId = SubscriptionManager.INVALID_SUBSCRIPTION_ID;
            recordAttempt(snapshot, "TelephonyManager.getSubscriptionId", false, 0, error);
        }

        addCandidate(snapshot, snapshot.defaultDataSubId, "default-data");
        addCandidate(snapshot, snapshot.activeDataSubId, "active-data");
        addCandidate(snapshot, snapshot.defaultSubId, "default");
        addCandidate(snapshot, snapshot.defaultVoiceSubId, "default-voice");
        addCandidate(snapshot, snapshot.defaultSmsSubId, "default-sms");
        addCandidate(snapshot, snapshot.baseTelephonySubId, "base-telephony");

        // Information-list APIs use different permission and visibility paths on
        // different Android and OEM releases, so query each independently.
        collectSubscriptionInfoList(snapshot, "getActiveSubscriptionInfoList", true);
        collectSubscriptionInfoList(snapshot, "getCompleteActiveSubscriptionInfoList", true);
        collectSubscriptionInfoList(snapshot, "getAllSubscriptionInfoList", false);
        collectSubscriptionInfoList(snapshot, "getAccessibleSubscriptionInfoList", false);

        // SystemApi ID-list methods avoid package-name filtering in some OEM builds.
        collectActiveIdArray(
                snapshot, "getActiveSubscriptionIdList", new Class<?>[0], new Object[0]);
        collectActiveIdArray(
                snapshot, "getCompleteActiveSubscriptionIdList", new Class<?>[0], new Object[0]);
        collectActiveIdArray(
                snapshot,
                "getActiveSubscriptionIdList(false)",
                new Class<?>[] {boolean.class},
                new Object[] {false});

        int activeModems = safeTelephonyCount(snapshot, "getActiveModemCount", new CountReader() {
            @Override public int read() { return baseTelephony.getActiveModemCount(); }
        });
        int phoneCount = safeTelephonyCount(snapshot, "getPhoneCount", new CountReader() {
            @Override public int read() { return baseTelephony.getPhoneCount(); }
        });
        int supportedModems = safeTelephonyCount(snapshot, "getSupportedModemCount", new CountReader() {
            @Override public int read() { return baseTelephony.getSupportedModemCount(); }
        });
        int slotCount = Math.max(activeModems, Math.max(phoneCount, supportedModems));
        // A broken count API must not prevent probing the two logical slots common
        // on dual-SIM Android devices. Invalid slot queries safely return null/-1.
        if (slotCount <= 0) slotCount = 2;
        slotCount = Math.min(slotCount, 4);
        snapshot.diagnostics.put("activeModemCount", activeModems);
        snapshot.diagnostics.put("phoneCount", phoneCount);
        snapshot.diagnostics.put("supportedModemCount", supportedModems);
        snapshot.diagnostics.put("scannedSlotCount", slotCount);

        for (int slot = 0; slot < slotCount; slot++) {
            scanSlot(snapshot, slot);
        }

        // Validate otherwise-stale defaults/base IDs through active and slot APIs.
        for (Integer candidate : new TreeSet<>(snapshot.candidateIds)) {
            validateCandidate(snapshot, candidate);
        }

        snapshot.preferredSubId = firstVerified(
                snapshot,
                snapshot.activeDataSubId,
                snapshot.defaultDataSubId,
                snapshot.defaultSubId,
                snapshot.baseTelephonySubId,
                snapshot.defaultVoiceSubId,
                snapshot.defaultSmsSubId);
        if (snapshot.preferredSubId == null && !snapshot.activeIds.isEmpty()) {
            snapshot.preferredSubId = snapshot.activeIds.iterator().next();
        }
        buildSubscriptionJson(snapshot);

        Map<String, Object> defaults = new LinkedHashMap<>();
        defaults.put("data", nullableSubId(snapshot.defaultDataSubId));
        defaults.put("activeData", nullableSubId(snapshot.activeDataSubId));
        defaults.put("system", nullableSubId(snapshot.defaultSubId));
        defaults.put("voice", nullableSubId(snapshot.defaultVoiceSubId));
        defaults.put("sms", nullableSubId(snapshot.defaultSmsSubId));
        defaults.put("baseTelephony", nullableSubId(snapshot.baseTelephonySubId));
        snapshot.diagnostics.put("defaults", defaults);
        snapshot.diagnostics.put("activeIds", new ArrayList<>(snapshot.activeIds));
        snapshot.diagnostics.put("writeVerifiedIds", new ArrayList<>(snapshot.writeVerifiedIds));
        snapshot.diagnostics.put("candidateIds", new ArrayList<>(snapshot.candidateIds));
        snapshot.diagnostics.put("preferredSubId", snapshot.preferredSubId);
        snapshot.diagnostics.put("apiAttempts", snapshot.apiAttempts);
        snapshot.diagnostics.put("slotScans", snapshot.slotScans);
        snapshot.diagnostics.put("sourcesBySubId", sourcesJson(snapshot.sourcesById));
        snapshot.diagnostics.put(
                "writePolicy",
                "active API check + logical slot + READY SIM + exact selection read");
        if (snapshot.activeIds.isEmpty()) {
            snapshot.error = "No active subscription ID was verified; base telephony monitoring is in use";
        }
        return snapshot;
    }

    private int readStaticSubId(
            SubscriptionSnapshot snapshot, String name, SubIdReader reader) {
        try {
            int value = reader.read();
            recordAttempt(snapshot, "SubscriptionManager." + name, true, 1, null);
            return value;
        } catch (Throwable error) {
            recordAttempt(snapshot, "SubscriptionManager." + name, false, 0, error);
            return SubscriptionManager.INVALID_SUBSCRIPTION_ID;
        }
    }

    private int safeTelephonyCount(
            SubscriptionSnapshot snapshot, String name, CountReader reader) {
        try {
            int value = Math.max(0, reader.read());
            recordAttempt(snapshot, "TelephonyManager." + name, true, value, null);
            return value;
        } catch (Throwable error) {
            recordAttempt(snapshot, "TelephonyManager." + name, false, 0, error);
            return 0;
        }
    }

    private void collectSubscriptionInfoList(
            SubscriptionSnapshot snapshot, String methodName, boolean provesActive) {
        try {
            Method method = SubscriptionManager.class.getMethod(methodName);
            Object value = method.invoke(subscriptions);
            if (value != null && !(value instanceof List)) {
                throw new IllegalStateException(methodName + " returned " + value.getClass().getName());
            }
            List<?> values = value == null ? Collections.emptyList() : (List<?>) value;
            int count = 0;
            for (Object item : values) {
                if (!(item instanceof SubscriptionInfo)) continue;
                SubscriptionInfo info = (SubscriptionInfo) item;
                addInfo(snapshot, info, methodName, provesActive);
                count++;
            }
            recordAttempt(snapshot, "SubscriptionManager." + methodName, true, count, null);
        } catch (Throwable error) {
            recordAttempt(snapshot, "SubscriptionManager." + methodName, false, 0, error);
        }
    }

    private void collectActiveIdArray(
            SubscriptionSnapshot snapshot,
            String label,
            Class<?>[] parameterTypes,
            Object[] arguments) {
        String methodName = label;
        int suffix = label.indexOf('(');
        if (suffix >= 0) methodName = label.substring(0, suffix);
        try {
            Method method = SubscriptionManager.class.getMethod(methodName, parameterTypes);
            Object value = method.invoke(subscriptions, arguments);
            if (!(value instanceof int[])) {
                throw new IllegalStateException(label + " did not return int[]");
            }
            int[] ids = (int[]) value;
            int count = 0;
            for (int id : ids) {
                if (!isRealSubId(id)) continue;
                markActive(snapshot, id, label, null);
                count++;
            }
            recordAttempt(snapshot, "SubscriptionManager." + label, true, count, null);
        } catch (Throwable error) {
            recordAttempt(snapshot, "SubscriptionManager." + label, false, 0, error);
        }
    }

    @SuppressWarnings("deprecation")
    private void scanSlot(SubscriptionSnapshot snapshot, int slot) {
        Map<String, Object> scan = new LinkedHashMap<>();
        Map<String, Object> results = new LinkedHashMap<>();
        scan.put("slotIndex", slot);
        int simState = TelephonyManager.SIM_STATE_UNKNOWN;
        try {
            simState = baseTelephony.getSimState(slot);
            results.put("getSimState", "ok");
        } catch (Throwable error) {
            results.put("getSimState", safeError(error));
        }
        scan.put("simState", simState);
        scan.put("simStateName", simStateName(simState));

        try {
            SubscriptionInfo info = subscriptions.getActiveSubscriptionInfoForSimSlotIndex(slot);
            if (info != null) {
                addInfo(snapshot, info, "active-info-for-slot", true);
                putSlot(snapshot, info.getSubscriptionId(), slot);
                results.put("activeInfo", info.getSubscriptionId());
            } else {
                results.put("activeInfo", null);
            }
        } catch (Throwable error) {
            results.put("activeInfoError", safeError(error));
        }

        try {
            int[] ids = subscriptions.getSubscriptionIds(slot);
            results.put("getSubscriptionIds", addSlotIds(
                    snapshot, ids, slot, "slot-subscription-ids"));
        } catch (Throwable error) {
            results.put("getSubscriptionIdsError", safeError(error));
        }

        try {
            Method method = SubscriptionManager.class.getMethod("getSubscriptionId", int.class);
            Object value = method.invoke(null, slot);
            int id = value instanceof Integer
                    ? (Integer) value : SubscriptionManager.INVALID_SUBSCRIPTION_ID;
            if (isRealSubId(id)) {
                markActive(snapshot, id, "slot-subscription-id", slot);
                results.put("getSubscriptionId", id);
            } else {
                results.put("getSubscriptionId", null);
            }
        } catch (Throwable error) {
            results.put("getSubscriptionIdError", safeError(error));
        }

        // Older/OEM frameworks can retain only the hidden array form.
        try {
            Method method = SubscriptionManager.class.getMethod("getSubId", int.class);
            Object value = method.invoke(null, slot);
            int[] ids = value instanceof int[] ? (int[]) value : null;
            results.put("getSubId", addSlotIds(snapshot, ids, slot, "slot-hidden-sub-id"));
        } catch (Throwable error) {
            results.put("getSubIdError", safeError(error));
        }
        scan.put("results", results);
        snapshot.slotScans.add(scan);
    }

    private List<Integer> addSlotIds(
            SubscriptionSnapshot snapshot, int[] ids, int slot, String source) {
        List<Integer> accepted = new ArrayList<>();
        if (ids == null) return accepted;
        for (int id : ids) {
            if (!isRealSubId(id)) continue;
            markActive(snapshot, id, source, slot);
            accepted.add(id);
        }
        return accepted;
    }

    private void validateCandidate(SubscriptionSnapshot snapshot, int candidate) {
        Map<String, Object> check = new LinkedHashMap<>();
        boolean activeNow = false;
        int mappedSlot = SubscriptionManager.INVALID_SIM_SLOT_INDEX;
        int mappedSimState = TelephonyManager.SIM_STATE_UNKNOWN;
        try {
            activeNow = subscriptions.isActiveSubscriptionId(candidate);
            check.put("isActiveSubscriptionId", activeNow);
            if (activeNow) {
                markActive(snapshot, candidate, "is-active", null);
            }
        } catch (Throwable error) {
            check.put("isActiveSubscriptionIdError", safeError(error));
        }

        try {
            SubscriptionInfo info = subscriptions.getActiveSubscriptionInfo(candidate);
            check.put("activeInfo", info != null);
            if (info != null) addInfo(snapshot, info, "active-info-by-id", true);
        } catch (Throwable error) {
            check.put("activeInfoError", safeError(error));
        }

        try {
            mappedSlot = SubscriptionManager.getSlotIndex(candidate);
            check.put("slotIndex", mappedSlot >= 0 ? mappedSlot : null);
            if (mappedSlot >= 0) {
                putSlot(snapshot, candidate, mappedSlot);
                addSource(snapshot, candidate, "sub-to-slot-map");
                try {
                    mappedSimState = baseTelephony.getSimState(mappedSlot);
                    check.put("mappedSimState", mappedSimState);
                    check.put("mappedSimStateName", simStateName(mappedSimState));
                } catch (Throwable error) {
                    check.put("mappedSimStateError", safeError(error));
                }
            }
        } catch (Throwable error) {
            check.put("slotIndexError", safeError(error));
        }
        boolean writeVerified = activeNow
                && mappedSlot >= 0
                && mappedSimState == TelephonyManager.SIM_STATE_READY;
        if (writeVerified) snapshot.writeVerifiedIds.add(candidate);
        check.put("verifiedActive", snapshot.activeIds.contains(candidate));
        check.put("writeVerified", writeVerified);
        snapshot.candidateChecks.put(String.valueOf(candidate), check);
        snapshot.diagnostics.put("candidateChecks", snapshot.candidateChecks);
    }

    private void addInfo(
            SubscriptionSnapshot snapshot,
            SubscriptionInfo info,
            String source,
            boolean provesActive) {
        if (info == null || !isRealSubId(info.getSubscriptionId())) return;
        int id = info.getSubscriptionId();
        snapshot.infoById.put(id, info);
        addCandidate(snapshot, id, source);
        if (info.getSimSlotIndex() >= 0) putSlot(snapshot, id, info.getSimSlotIndex());
        if (provesActive) markActive(snapshot, id, source, info.getSimSlotIndex());
    }

    private void addCandidate(SubscriptionSnapshot snapshot, int id, String source) {
        if (!isRealSubId(id)) return;
        snapshot.candidateIds.add(id);
        addSource(snapshot, id, source);
    }

    private void markActive(
            SubscriptionSnapshot snapshot, int id, String source, Integer slot) {
        if (!isRealSubId(id)) return;
        snapshot.activeIds.add(id);
        snapshot.candidateIds.add(id);
        addSource(snapshot, id, source);
        if (slot != null && slot >= 0) putSlot(snapshot, id, slot);
    }

    private static void addSource(SubscriptionSnapshot snapshot, int id, String source) {
        Set<String> sources = snapshot.sourcesById.get(id);
        if (sources == null) {
            sources = new TreeSet<>();
            snapshot.sourcesById.put(id, sources);
        }
        sources.add(source);
    }

    private static void putSlot(SubscriptionSnapshot snapshot, int id, int slot) {
        if (isRealSubId(id) && slot >= 0) snapshot.slotById.put(id, slot);
    }

    private void buildSubscriptionJson(final SubscriptionSnapshot snapshot) {
        List<Integer> ids = new ArrayList<>(snapshot.activeIds);
        Collections.sort(ids, new Comparator<Integer>() {
            @Override public int compare(Integer left, Integer right) {
                int leftSlot = slotFor(snapshot, left);
                int rightSlot = slotFor(snapshot, right);
                int slotOrder = Integer.compare(leftSlot < 0 ? Integer.MAX_VALUE : leftSlot,
                        rightSlot < 0 ? Integer.MAX_VALUE : rightSlot);
                return slotOrder != 0 ? slotOrder : Integer.compare(left, right);
            }
        });
        boolean realDefaultData = snapshot.activeIds.contains(snapshot.defaultDataSubId);
        for (Integer id : ids) {
            SubscriptionInfo info = snapshot.infoById.get(id);
            int slot = info != null && info.getSimSlotIndex() >= 0
                    ? info.getSimSlotIndex() : slotFor(snapshot, id);
            String carrier = info == null ? "" : chars(info.getCarrierName());
            String display = info == null ? "" : chars(info.getDisplayName());
            if (carrier.isEmpty()) {
                try {
                    TelephonyManager manager = baseTelephony.createForSubscriptionId(id);
                    carrier = string(manager.getSimOperatorName());
                    if (carrier.isEmpty()) carrier = string(manager.getNetworkOperatorName());
                } catch (Throwable ignored) {}
            }
            if (display.isEmpty()) {
                display = slot >= 0 ? "SIM " + (slot + 1) : "Subscription " + id;
            }
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("subId", id);
            item.put("slotIndex", slot);
            item.put("carrierName", carrier);
            item.put("displayName", display);
            item.put("defaultData", realDefaultData
                    ? id == snapshot.defaultDataSubId : id.equals(snapshot.preferredSubId));
            item.put("verifiedActive", true);
            Set<String> sources = snapshot.sourcesById.get(id);
            item.put("sources", sources == null
                    ? Collections.emptyList() : new ArrayList<>(sources));
            snapshot.json.add(item);
        }
    }

    private static int slotFor(SubscriptionSnapshot snapshot, int id) {
        Integer known = snapshot.slotById.get(id);
        if (known != null) return known;
        try {
            return SubscriptionManager.getSlotIndex(id);
        } catch (Throwable ignored) {
            return SubscriptionManager.INVALID_SIM_SLOT_INDEX;
        }
    }

    private static Integer firstVerified(SubscriptionSnapshot snapshot, int... candidates) {
        for (int id : candidates) {
            if (snapshot.activeIds.contains(id)) return id;
        }
        return null;
    }

    private static Integer nullableSubId(int id) {
        return isRealSubId(id) ? id : null;
    }

    private static boolean isRealSubId(int id) {
        return id >= 0 && id != SubscriptionManager.DEFAULT_SUBSCRIPTION_ID;
    }

    private static String simStateName(int state) {
        switch (state) {
            case TelephonyManager.SIM_STATE_ABSENT: return "ABSENT";
            case TelephonyManager.SIM_STATE_PIN_REQUIRED: return "PIN_REQUIRED";
            case TelephonyManager.SIM_STATE_PUK_REQUIRED: return "PUK_REQUIRED";
            case TelephonyManager.SIM_STATE_NETWORK_LOCKED: return "NETWORK_LOCKED";
            case TelephonyManager.SIM_STATE_READY: return "READY";
            case TelephonyManager.SIM_STATE_NOT_READY: return "NOT_READY";
            case TelephonyManager.SIM_STATE_PERM_DISABLED: return "PERM_DISABLED";
            case TelephonyManager.SIM_STATE_CARD_IO_ERROR: return "CARD_IO_ERROR";
            case TelephonyManager.SIM_STATE_CARD_RESTRICTED: return "CARD_RESTRICTED";
            default: return "UNKNOWN";
        }
    }

    private static void recordAttempt(
            SubscriptionSnapshot snapshot,
            String name,
            boolean ok,
            int count,
            Throwable error) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("ok", ok);
        result.put("count", count);
        if (error != null) result.put("error", safeError(error));
        snapshot.apiAttempts.put(name, result);
    }

    private static Map<String, Object> sourcesJson(Map<Integer, Set<String>> sources) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (Map.Entry<Integer, Set<String>> entry : sources.entrySet()) {
            result.put(String.valueOf(entry.getKey()), new ArrayList<>(entry.getValue()));
        }
        return result;
    }

    private Integer resolveSubId(
            Integer requested, SubscriptionSnapshot snapshot, boolean allowNone)
            throws Main.CommandException {
        if (requested != null) {
            if (snapshot.activeIds.contains(requested)) return requested;
            if (allowNone) {
                snapshot.diagnostics.put("requestedSubIdRejected", requested);
                return snapshot.preferredSubId;
            }
            throw commandError(
                    "INVALID_SUBSCRIPTION",
                    "Subscription " + requested + " is not verified active",
                    65);
        }
        if (snapshot.preferredSubId != null) return snapshot.preferredSubId;
        if (allowNone) return null;
        throw commandError(
                "NO_ACTIVE_SUBSCRIPTION",
                "No active cellular subscription ID could be verified",
                69);
    }

    private int requireSubId(Integer requested, SubscriptionSnapshot snapshot)
            throws Main.CommandException {
        Integer resolved = resolveSubId(requested, snapshot, false);
        if (resolved == null) {
            throw commandError(
                    "NO_ACTIVE_SUBSCRIPTION",
                    "No active cellular subscription ID could be verified",
                    69);
        }
        if (!snapshot.activeIds.contains(resolved)) {
            throw commandError(
                    "UNVERIFIED_SUBSCRIPTION",
                    "Refusing a radio write without a verified active subscription",
                    69);
        }
        assertActiveNow(resolved);
        return resolved;
    }

    private void assertActiveNow(int subId) throws Main.CommandException {
        try {
            if (!subscriptions.isActiveSubscriptionId(subId)) {
                throw commandError(
                        "SUBSCRIPTION_NOT_ACTIVE",
                        "Subscription " + subId + " is no longer reported active; write refused",
                        69);
            }
            int slot = SubscriptionManager.getSlotIndex(subId);
            if (slot < 0) {
                throw commandError(
                        "SUBSCRIPTION_SLOT_UNVERIFIED",
                        "The active subscription has no verified logical SIM slot; write refused",
                        69);
            }
            int simState = baseTelephony.getSimState(slot);
            if (simState != TelephonyManager.SIM_STATE_READY) {
                throw commandError(
                        "SIM_NOT_READY",
                        "SIM slot " + slot + " is " + simStateName(simState)
                                + "; write refused",
                        69);
            }
            return;
        } catch (Main.CommandException error) {
            throw error;
        } catch (Throwable error) {
            throw commandError(
                    "ACTIVE_CHECK_FAILED",
                    "Could not verify the subscription immediately before write: " + safeError(error),
                    69);
        }
    }

    @SuppressWarnings("unchecked")
    private List<RadioAccessSpecifier> getSelection(TelephonyManager telephony) throws Exception {
        Method method;
        try {
            method = TelephonyManager.class.getMethod("getSystemSelectionChannels");
        } catch (NoSuchMethodException error) {
            throw commandError(
                    "READ_API_UNAVAILABLE",
                    "getSystemSelectionChannels is not exposed by this ROM",
                    69);
        }
        try {
            Object value = method.invoke(telephony);
            if (value == null) {
                throw commandError(
                        "READ_UNSUPPORTED",
                        "The modem returned no system-selection channel state",
                        69);
            }
            return new ArrayList<>((List<RadioAccessSpecifier>) value);
        } catch (InvocationTargetException error) {
            throw reflectFailure("READ_FAILED", error);
        }
    }

    private void setSelection(
            TelephonyManager telephony, List<RadioAccessSpecifier> specifiers) throws Exception {
        Method method;
        try {
            method = TelephonyManager.class.getMethod(
                    "setSystemSelectionChannels", List.class, Executor.class, Consumer.class);
        } catch (NoSuchMethodException error) {
            throw commandError(
                    "WRITE_API_UNAVAILABLE",
                    "The callback form of setSystemSelectionChannels is not exposed by this ROM",
                    69);
        }

        final ArrayBlockingQueue<Boolean> callback = new ArrayBlockingQueue<>(1);
        Consumer<Boolean> consumer = new Consumer<Boolean>() {
            @Override public void accept(Boolean value) {
                callback.offer(Boolean.TRUE.equals(value));
            }
        };
        try {
            method.invoke(telephony, specifiers, DIRECT_EXECUTOR, consumer);
        } catch (InvocationTargetException error) {
            throw reflectFailure("WRITE_FAILED", error);
        }
        Boolean accepted;
        try {
            accepted = callback.poll(CALLBACK_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw commandError("WRITE_INTERRUPTED", "Interrupted while awaiting modem callback", 75);
        }
        if (accepted == null) {
            throw commandError(
                    "CALLBACK_TIMEOUT",
                    "The modem did not acknowledge the selection within 10 seconds",
                    75);
        }
        if (!accepted) {
            throw commandError(
                    "MODEM_REJECTED",
                    "The modem rejected this system-selection channel request",
                    69);
        }
    }

    private List<RadioAccessSpecifier> getSelectionBestEffort(
            TelephonyManager telephony, List<RadioAccessSpecifier> fallback) {
        try {
            return getSelection(telephony);
        } catch (Throwable ignored) {
            return new ArrayList<>(fallback);
        }
    }

    private Main.CommandException reflectFailure(String code, InvocationTargetException error) {
        Throwable cause = error.getCause() == null ? error : error.getCause();
        return commandError(code, safeError(cause), 69);
    }

    private Main.CommandException commandError(String code, String message, int exitCode) {
        return new Main.CommandException(code, message, exitCode);
    }

    private static int[] parseInputBands(String csv, Set<Integer> allowed, String rat)
            throws Main.CommandException {
        if ("-".equals(csv)) return new int[0];
        if (csv == null || csv.length() > 256 || !csv.matches("[0-9]+(,[0-9]+)*")) {
            throw new Main.CommandException(
                    "INVALID_BANDS", rat + " bands must be a comma-separated numeric list or -", 65);
        }
        TreeSet<Integer> result = new TreeSet<>();
        for (String token : csv.split(",")) {
            final int band;
            try {
                band = Integer.parseInt(token);
            } catch (NumberFormatException error) {
                throw new Main.CommandException("INVALID_BANDS", "Invalid " + rat + " band", 65);
            }
            if (!String.valueOf(band).equals(token) || !allowed.contains(band)) {
                throw new Main.CommandException(
                        "UNSUPPORTED_BAND",
                        rat + " band " + token
                                + " is not in the standards-level input allowlist",
                        65);
            }
            if (!result.add(band)) {
                throw new Main.CommandException(
                        "DUPLICATE_BAND", rat + " band " + band + " is duplicated", 65);
            }
        }
        return toIntArray(result);
    }

    private static Map<String, Object> selectionJson(List<RadioAccessSpecifier> specifiers) {
        Map<String, Object> selection = new LinkedHashMap<>();
        boolean known = specifiers != null;
        TreeSet<Integer> lte = new TreeSet<>();
        TreeSet<Integer> nr = new TreeSet<>();
        List<Map<String, Object>> raw = new ArrayList<>();
        if (known) {
            for (RadioAccessSpecifier specifier : specifiers) {
                if (specifier.getRadioAccessNetwork() == RAN_EUTRAN) {
                    addAll(lte, specifier.getBands());
                } else if (specifier.getRadioAccessNetwork() == RAN_NGRAN) {
                    addAll(nr, specifier.getBands());
                }
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("ran", specifier.getRadioAccessNetwork());
                item.put("rat", ranName(specifier.getRadioAccessNetwork()));
                item.put("bands", ints(specifier.getBands()));
                item.put("channels", ints(specifier.getChannels()));
                raw.add(item);
            }
        }
        selection.put("auto", known && specifiers.isEmpty());
        selection.put("lte", new ArrayList<>(lte));
        selection.put("nr", new ArrayList<>(nr));
        selection.put("known", known);
        selection.put("specifiers", raw);
        return selection;
    }

    private static String encodeRestoreToken(List<RadioAccessSpecifier> specifiers) {
        if (specifiers == null || specifiers.isEmpty()) return "auto";
        StringBuilder token = new StringBuilder();
        for (RadioAccessSpecifier specifier : specifiers) {
            if (token.length() > 0) token.append(';');
            token.append(specifier.getRadioAccessNetwork()).append(':');
            appendInts(token, specifier.getBands());
            token.append(':');
            appendInts(token, specifier.getChannels());
        }
        return token.toString();
    }

    private static List<RadioAccessSpecifier> decodeRestoreToken(String token)
            throws Main.CommandException {
        if ("auto".equals(token)) return Collections.emptyList();
        if (token == null || token.length() > 4096 || !token.matches("[0-9,:;]+")) {
            throw new Main.CommandException("INVALID_RESTORE_TOKEN", "Invalid restore token", 65);
        }
        List<RadioAccessSpecifier> result = new ArrayList<>();
        for (String encoded : token.split(";", -1)) {
            String[] fields = encoded.split(":", -1);
            if (fields.length != 3) {
                throw new Main.CommandException("INVALID_RESTORE_TOKEN", "Invalid restore token", 65);
            }
            int ran = strictInt(fields[0], 1, 6, "radio access network");
            int[] bands = parseRestoreInts(fields[1], 1, 512, 256, "band");
            int[] channels = parseRestoreInts(fields[2], 0, 4_000_000, 512, "channel");
            try {
                result.add(new RadioAccessSpecifier(ran, bands, channels));
            } catch (RuntimeException error) {
                throw new Main.CommandException(
                        "INVALID_RESTORE_TOKEN", "Restore token is not accepted by Android", 65);
            }
        }
        if (result.isEmpty() || result.size() > 16) {
            throw new Main.CommandException("INVALID_RESTORE_TOKEN", "Invalid restore token", 65);
        }
        return result;
    }

    private static int[] parseRestoreInts(
            String csv, int minimum, int maximum, int maxCount, String label)
            throws Main.CommandException {
        if (csv.isEmpty()) return new int[0];
        String[] parts = csv.split(",", -1);
        if (parts.length > maxCount) {
            throw new Main.CommandException("INVALID_RESTORE_TOKEN", "Too many " + label + "s", 65);
        }
        int[] values = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            values[i] = strictInt(parts[i], minimum, maximum, label);
        }
        return values;
    }

    private static boolean hasOrdinaryServingBand(int[] lte, int[] nr) {
        for (int band : lte) {
            if (!BandPolicy.LTE_SUPPLEMENTAL_DOWNLINK_SET.contains(band)) return true;
        }
        for (int band : nr) {
            if (!BandPolicy.NR_SUPPLEMENTAL_DOWNLINK_SET.contains(band)
                    && !BandPolicy.NR_SUPPLEMENTAL_UPLINK_SET.contains(band)) {
                return true;
            }
        }
        return false;
    }

    private static int strictInt(String token, int minimum, int maximum, String label)
            throws Main.CommandException {
        if (!token.matches("0|[1-9][0-9]*")) {
            throw new Main.CommandException("INVALID_RESTORE_TOKEN", "Invalid " + label, 65);
        }
        try {
            int value = Integer.parseInt(token);
            if (value < minimum || value > maximum) throw new NumberFormatException();
            return value;
        } catch (NumberFormatException error) {
            throw new Main.CommandException("INVALID_RESTORE_TOKEN", "Invalid " + label, 65);
        }
    }

    private LiveRadio readLiveRadio(TelephonyManager telephony) {
        LiveRadio live = new LiveRadio();
        List<CellInfo> cellInfos = Collections.emptyList();
        try {
            List<CellInfo> value = telephony.getAllCellInfo();
            if (value != null) cellInfos = value;
            live.cellReadSucceeded = true;
        } catch (Throwable error) {
            live.cellError = safeError(error);
        }

        List<PhysicalChannelConfig> physical = Collections.emptyList();
        try {
            physical = physicalChannels(telephony);
            live.physicalReadSucceeded = true;
        } catch (Throwable error) {
            live.physicalError = safeError(error);
        }

        for (PhysicalChannelConfig config : physical) {
            Map<String, Object> raw = physicalJson(config);
            live.physicalChannels.add(raw);
            String rat = networkTypeRat(config.getNetworkType());
            if (rat == null) continue;
            int connectionStatus = config.getConnectionStatus();
            // CA is proven only by a selected-SIM LTE primary plus LTE secondary.
            // Unknown PCC entries and aggregate CellInfo can otherwise create DSDS/OEM
            // false positives.
            if ("LTE".equals(rat)
                    && (connectionStatus == CellInfo.CONNECTION_PRIMARY_SERVING
                    || connectionStatus == CellInfo.CONNECTION_SECONDARY_SERVING)) {
                live.physicalLteCarrierKeys.add(physicalCarrierKey(config));
                if (connectionStatus == CellInfo.CONNECTION_PRIMARY_SERVING) {
                    live.physicalLtePrimaryCount++;
                } else {
                    live.physicalLteSecondaryCount++;
                }
            }
            Map<String, Object> serving = blankServing(
                    rat,
                    availablePositive(config.getBand()),
                    connectionStatus == CellInfo.CONNECTION_PRIMARY_SERVING,
                    true,
                    availableNonNegative(config.getDownlinkChannelNumber()),
                    availableNonNegative(config.getPhysicalCellId()),
                    availablePositive(config.getCellBandwidthDownlinkKhz()));
            live.serving.add(serving);
            addObserved(live, rat, availablePositive(config.getBand()));
        }

        for (CellInfo info : cellInfos) {
            addIdentityBands(live, info);
            CellReading reading = readCell(info);
            if (reading == null) continue;
            live.cells.add(reading.json());
            addObserved(live, reading.rat, reading.band);
            if (!reading.registered
                    && reading.connectionStatus != CellInfo.CONNECTION_PRIMARY_SERVING
                    && reading.connectionStatus != CellInfo.CONNECTION_SECONDARY_SERVING) {
                continue;
            }
            Map<String, Object> matching = findServingMatch(live.serving, reading);
            if (matching == null) {
                matching = reading.servingJson();
                live.serving.add(matching);
            } else {
                mergeCell(matching, reading);
            }
        }
        return live;
    }

    private static void addIdentityBands(LiveRadio live, CellInfo info) {
        try {
            if (info instanceof CellInfoLte) {
                addObservedBands(
                        live, "LTE", ((CellInfoLte) info).getCellIdentity().getBands());
            } else if (info instanceof CellInfoNr) {
                addObservedBands(
                        live, "NR",
                        ((CellIdentityNr) ((CellInfoNr) info).getCellIdentity()).getBands());
            }
        } catch (Throwable ignored) {
            // Keep the representative CellReading path available if an OEM
            // identity exposes a malformed multi-band array.
        }
    }

    private static List<PhysicalChannelConfig> physicalChannels(TelephonyManager telephony)
            throws Exception {
        PhysicalListener callback = new PhysicalListener();
        telephony.registerTelephonyCallback(DIRECT_EXECUTOR, callback);
        try {
            boolean received = callback.latch.await(
                    PHYSICAL_CHANNEL_WAIT_MILLIS, TimeUnit.MILLISECONDS);
            if (!received) {
                throw new IllegalStateException("Physical-channel callback timed out");
            }
            return callback.value == null
                    ? Collections.<PhysicalChannelConfig>emptyList()
                    : new ArrayList<>(callback.value);
        } finally {
            try { telephony.unregisterTelephonyCallback(callback); } catch (Throwable ignored) {}
        }
    }

    private static final class PhysicalListener extends TelephonyCallback
            implements TelephonyCallback.PhysicalChannelConfigListener {
        final CountDownLatch latch = new CountDownLatch(1);
        volatile List<PhysicalChannelConfig> value;

        @Override public void onPhysicalChannelConfigChanged(List<PhysicalChannelConfig> configs) {
            value = configs;
            latch.countDown();
        }
    }

    private static CellReading readCell(CellInfo info) {
        try {
            if (info instanceof CellInfoLte) {
                CellInfoLte lte = (CellInfoLte) info;
                CellIdentityLte identity = lte.getCellIdentity();
                CellSignalStrengthLte signal = lte.getCellSignalStrength();
                Integer rssnr = signalValue(signal.getRssnr());
                return new CellReading(
                        "LTE", firstBand(identity.getBands()), info.isRegistered(),
                        info.getCellConnectionStatus(),
                        availableNonNegative(identity.getEarfcn()),
                        availableNonNegative(identity.getPci()),
                        availablePositive(identity.getBandwidth()),
                        signalLevelValue(signal.getLevel()),
                        signalValue(signal.getRsrp()), signalValue(signal.getRsrq()),
                        rssnr == null ? null : rssnr.doubleValue() / 10.0d);
            }
            if (info instanceof CellInfoNr) {
                CellInfoNr nr = (CellInfoNr) info;
                CellIdentityNr identity = (CellIdentityNr) nr.getCellIdentity();
                CellSignalStrengthNr signal = (CellSignalStrengthNr) nr.getCellSignalStrength();
                return new CellReading(
                        "NR", firstBand(identity.getBands()), info.isRegistered(),
                        info.getCellConnectionStatus(),
                        availableNonNegative(identity.getNrarfcn()),
                        availableNonNegative(identity.getPci()), null,
                        signalLevelValue(signal.getLevel()),
                        signalValue(signal.getSsRsrp()), signalValue(signal.getSsRsrq()),
                        signalValue(signal.getSsSinr()));
            }
        } catch (Throwable ignored) {
            // A malformed vendor CellInfo object must not break the whole status report.
        }
        return null;
    }

    @SuppressWarnings("deprecation")
    private static void addServiceStateCells(LiveRadio live, ServiceState serviceState) {
        try {
            List<NetworkRegistrationInfo> registrations =
                    serviceState.getNetworkRegistrationInfoList();
            if (registrations == null) return;
            for (NetworkRegistrationInfo registration : registrations) {
                if (registration == null
                        || !registration.isRegistered()
                        || registration.getTransportType()
                                != AccessNetworkConstants.TRANSPORT_TYPE_WWAN) {
                    continue;
                }
                CellIdentity identity = registration.getCellIdentity();
                CellReading reading = null;
                if (identity instanceof CellIdentityLte) {
                    CellIdentityLte lte = (CellIdentityLte) identity;
                    addObservedBands(live, "LTE", lte.getBands());
                    reading = new CellReading(
                            "LTE", firstBand(lte.getBands()), true,
                            CellInfo.CONNECTION_PRIMARY_SERVING,
                            availableNonNegative(lte.getEarfcn()),
                            availableNonNegative(lte.getPci()),
                            availablePositive(lte.getBandwidth()),
                            null, null, null, null);
                } else if (identity instanceof CellIdentityNr) {
                    CellIdentityNr nr = (CellIdentityNr) identity;
                    addObservedBands(live, "NR", nr.getBands());
                    reading = new CellReading(
                            "NR", firstBand(nr.getBands()), true,
                            CellInfo.CONNECTION_PRIMARY_SERVING,
                            availableNonNegative(nr.getNrarfcn()),
                            availableNonNegative(nr.getPci()), null,
                            null, null, null, null);
                }
                if (reading == null) continue;
                addObserved(live, reading.rat, reading.band);
                Map<String, Object> matching = findServingMatch(live.serving, reading);
                if (matching == null) live.serving.add(reading.servingJson());
                Map<String, Object> raw = reading.json();
                raw.put("source", "service-state");
                raw.put("domain", registration.getDomain());
                raw.put("accessNetworkTechnology", registration.getAccessNetworkTechnology());
                live.cells.add(raw);
            }
        } catch (Throwable ignored) {
            // ServiceState itself still remains useful for connected/in-service status.
        }
    }

    private static Map<String, Object> findServingMatch(
            List<Map<String, Object>> serving, CellReading cell) {
        for (Map<String, Object> candidate : serving) {
            if (!cell.rat.equals(candidate.get("rat"))) continue;
            Object candidateBand = candidate.get("band");
            Object candidatePci = candidate.get("pci");
            Object candidateChannel = candidate.get("channel");
            if (cell.band != null && candidateBand != null && !cell.band.equals(candidateBand)) continue;
            if (cell.pci != null && candidatePci != null && !cell.pci.equals(candidatePci)) continue;
            if (cell.channel != null && candidateChannel != null
                    && !cell.channel.equals(candidateChannel)) continue;
            return candidate;
        }
        return null;
    }

    private static void mergeCell(Map<String, Object> target, CellReading cell) {
        if (target.get("band") == null) target.put("band", cell.band);
        target.put("registered", cell.registered);
        if (cell.connectionStatus == CellInfo.CONNECTION_PRIMARY_SERVING) {
            target.put("primary", true);
        }
        if (target.get("channel") == null) target.put("channel", cell.channel);
        if (target.get("pci") == null) target.put("pci", cell.pci);
        if (target.get("bandwidthKhz") == null) target.put("bandwidthKhz", cell.bandwidthKhz);
        target.put("level", cell.level);
        target.put("rsrp", cell.rsrp);
        target.put("rsrq", cell.rsrq);
        target.put("sinr", cell.sinr);
    }

    private static Map<String, Object> blankServing(
            String rat, Integer band, boolean primary, boolean registered,
            Integer channel, Integer pci, Integer bandwidthKhz) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("rat", rat);
        value.put("band", band);
        value.put("primary", primary);
        value.put("registered", registered);
        value.put("channel", channel);
        value.put("pci", pci);
        value.put("bandwidthKhz", bandwidthKhz);
        value.put("level", null);
        value.put("rsrp", null);
        value.put("rsrq", null);
        value.put("sinr", null);
        return value;
    }

    private static Map<String, Object> physicalJson(PhysicalChannelConfig config) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("networkType", config.getNetworkType());
        value.put("rat", networkTypeRat(config.getNetworkType()));
        value.put("band", availablePositive(config.getBand()));
        value.put("primary",
                config.getConnectionStatus() == CellInfo.CONNECTION_PRIMARY_SERVING);
        value.put("connectionStatus", config.getConnectionStatus());
        value.put("downlinkChannel", availableNonNegative(config.getDownlinkChannelNumber()));
        value.put("uplinkChannel", availableNonNegative(config.getUplinkChannelNumber()));
        value.put("pci", availableNonNegative(config.getPhysicalCellId()));
        value.put("downlinkBandwidthKhz", availablePositive(config.getCellBandwidthDownlinkKhz()));
        value.put("uplinkBandwidthKhz", availablePositive(config.getCellBandwidthUplinkKhz()));
        value.put("downlinkFrequencyKhz", availablePositive(config.getDownlinkFrequencyKhz()));
        value.put("uplinkFrequencyKhz", availablePositive(config.getUplinkFrequencyKhz()));
        return value;
    }

    private static void addObserved(LiveRadio live, String rat, Integer band) {
        if (band == null) return;
        if ("LTE".equals(rat)) live.observedLte.add(band);
        if ("NR".equals(rat)) live.observedNr.add(band);
    }

    private static void addObservedBands(LiveRadio live, String rat, int[] bands) {
        if (bands == null) return;
        for (int band : bands) {
            if (band > 0) addObserved(live, rat, band);
        }
    }

    private static String mode(
            List<Map<String, Object>> serving,
            int networkType,
            boolean connected,
            boolean carrierAggregationActive) {
        boolean lte = false;
        boolean nr = false;
        for (Map<String, Object> cell : serving) {
            lte |= "LTE".equals(cell.get("rat"));
            nr |= "NR".equals(cell.get("rat"));
        }
        if (lte && nr) return "NSA";
        if (nr) return "SA";
        if (lte && carrierAggregationActive) return "LTE_CA";
        if (lte) return "LTE";
        if (networkType == TelephonyManager.NETWORK_TYPE_NR) return "NR";
        if (networkType == TelephonyManager.NETWORK_TYPE_LTE) {
            return carrierAggregationActive ? "LTE_CA" : "LTE";
        }
        return connected ? "OTHER" : "NONE";
    }

    private static String physicalCarrierKey(PhysicalChannelConfig config) {
        return config.getBand() + ":"
                + config.getDownlinkChannelNumber() + ":"
                + config.getPhysicalCellId();
    }

    private static BandDiscovery discoverBands(
            LiveRadio live, List<RadioAccessSpecifier> specifiers) {
        BandDiscovery discovery = new BandDiscovery();
        discovery.observedLte.addAll(live.observedLte);
        discovery.observedNr.addAll(live.observedNr);

        for (Map<String, Object> carrier : live.serving) {
            Object rat = carrier.get("rat");
            Object rawBand = carrier.get("band");
            if (!(rawBand instanceof Number)) continue;
            int band = ((Number) rawBand).intValue();
            if (band <= 0) continue;
            if ("LTE".equals(rat)) discovery.servingLte.add(band);
            if ("NR".equals(rat)) discovery.servingNr.add(band);
        }

        if (specifiers != null) {
            for (RadioAccessSpecifier specifier : specifiers) {
                int ran = specifier.getRadioAccessNetwork();
                int[] bands = specifier.getBands();
                if (bands == null) continue;
                for (int band : bands) {
                    if (band <= 0) continue;
                    if (ran == RAN_EUTRAN) discovery.selectionLte.add(band);
                    if (ran == RAN_NGRAN) discovery.selectionNr.add(band);
                }
            }
        }

        discovery.allLte.addAll(discovery.servingLte);
        discovery.allLte.addAll(discovery.observedLte);
        discovery.allLte.addAll(discovery.selectionLte);
        discovery.allNr.addAll(discovery.servingNr);
        discovery.allNr.addAll(discovery.observedNr);
        discovery.allNr.addAll(discovery.selectionNr);
        return discovery;
    }

    private Map<String, Object> device() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("model", string(Build.MODEL));
        value.put("product", string(Build.PRODUCT));
        value.put("manufacturer", string(Build.MANUFACTURER));
        value.put("brand", string(Build.BRAND));
        value.put("device", string(Build.DEVICE));
        value.put("hardware", string(Build.HARDWARE));
        value.put("sdk", Build.VERSION.SDK_INT);
        value.put("release", string(Build.VERSION.RELEASE));
        value.put("rom", string(Build.DISPLAY));
        value.put("buildId", string(Build.ID));
        value.put("incremental", string(Build.VERSION.INCREMENTAL));
        return value;
    }

    private static Map<String, Object> inputPolicy() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("lte", ints(BandPolicy.LTE_INPUTS));
        value.put("nr", ints(BandPolicy.NR_INPUTS));
        value.put("supplementalDownlinkLte", ints(BandPolicy.LTE_SUPPLEMENTAL_DOWNLINK));
        value.put("supplementalDownlinkNr", ints(BandPolicy.NR_SUPPLEMENTAL_DOWNLINK));
        value.put("supplementalUplinkNr", ints(BandPolicy.NR_SUPPLEMENTAL_UPLINK));
        value.put("basis", BandPolicy.BASIS);
        value.put("deviceCapabilityClaim", false);
        return value;
    }

    private static Map<String, Object> capability(
            TelephonyManager telephony,
            boolean telemetryRead,
            boolean selectionRead,
            String selectionError,
            boolean activeSubscriptionVerified,
            String monitoringScope) {
        boolean readApi = hasMethod("getSystemSelectionChannels");
        boolean writeApi = hasMethod(
                "setSystemSelectionChannels", List.class, Executor.class, Consumer.class);
        boolean read = telephony != null && (telemetryRead || selectionRead);
        boolean write = telephony != null
                && activeSubscriptionVerified
                && selectionRead
                && writeApi;
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("read", read);
        value.put("write", write);
        value.put("telemetryRead", telemetryRead);
        value.put("selectionRead", selectionRead);
        value.put("activeSubscriptionVerified", activeSubscriptionVerified);
        value.put("writeSubscriptionVerified", activeSubscriptionVerified);
        value.put("monitoringScope", monitoringScope);
        value.put("selectionReadApi", readApi);
        value.put("selectionWriteApi", writeApi);
        String reason;
        if (Build.VERSION.SDK_INT < 31) {
            reason = "Android 12/API 31 or newer is required";
        } else if (!activeSubscriptionVerified && read) {
            reason = "Telephony monitoring is available, but no active READY subscription "
                    + "and logical slot were verified; writes are disabled";
        } else if (!activeSubscriptionVerified) {
            reason = "No active READY subscription/slot was verified and monitoring failed";
        } else if (!readApi || !writeApi) {
            reason = "This ROM does not expose both AOSP system-selection channel APIs";
        } else if (!selectionRead) {
            reason = selectionError == null
                    ? "Live monitoring works, but exact selection state could not be read"
                    : "Exact selection read failed: " + selectionError;
        } else {
            reason = "AOSP APIs available; each write still requires a positive modem callback";
        }
        value.put("reason", reason);
        return value;
    }

    private static boolean hasMethod(String name, Class<?>... parameters) {
        try {
            TelephonyManager.class.getMethod(name, parameters);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static String networkTypeRat(int networkType) {
        if (networkType == TelephonyManager.NETWORK_TYPE_LTE) return "LTE";
        if (networkType == TelephonyManager.NETWORK_TYPE_NR) return "NR";
        return null;
    }

    private static String ranName(int ran) {
        if (ran == RAN_EUTRAN) return "LTE";
        if (ran == RAN_NGRAN) return "NR";
        return "RAN-" + ran;
    }

    private static Integer firstBand(int[] bands) {
        return bands == null || bands.length == 0 ? null : availablePositive(bands[0]);
    }

    private static Integer availablePositive(int value) {
        return value <= 0 || value == Integer.MAX_VALUE ? null : value;
    }

    private static Integer availableNonNegative(int value) {
        return value < 0 || value == Integer.MAX_VALUE ? null : value;
    }

    private static Integer signalValue(int value) {
        return value == CellInfo.UNAVAILABLE || value == Integer.MAX_VALUE ? null : value;
    }

    private static Integer signalLevelValue(int value) {
        return value >= 0 && value <= 4 ? value : null;
    }

    private static void addAll(Set<Integer> target, int[] values) {
        if (values == null) return;
        for (int value : values) target.add(value);
    }

    private static List<Integer> ints(int[] values) {
        List<Integer> result = new ArrayList<>();
        if (values != null) for (int value : values) result.add(value);
        return result;
    }

    private static int[] toIntArray(Set<Integer> values) {
        int[] result = new int[values.size()];
        int index = 0;
        for (Integer value : values) result[index++] = value;
        return result;
    }

    private static void appendInts(StringBuilder output, int[] values) {
        if (values == null) return;
        for (int i = 0; i < values.length; i++) {
            if (i > 0) output.append(',');
            output.append(values[i]);
        }
    }

    private static String chars(CharSequence value) {
        return value == null ? "" : value.toString();
    }

    private static String string(String value) {
        return value == null ? "" : value;
    }

    private static String safeError(Throwable error) {
        Throwable current = error;
        while (current instanceof InvocationTargetException
                && ((InvocationTargetException) current).getCause() != null) {
            current = ((InvocationTargetException) current).getCause();
        }
        String message = current.getMessage();
        if (message == null || message.trim().isEmpty()) message = current.toString();
        message = message.replace('\n', ' ').replace('\r', ' ');
        return message.length() > 240 ? message.substring(0, 240) : message;
    }

    private static final class SubscriptionSnapshot {
        final List<Map<String, Object>> json = new ArrayList<>();
        final Set<Integer> activeIds = new TreeSet<>();
        final Set<Integer> writeVerifiedIds = new TreeSet<>();
        final Set<Integer> candidateIds = new TreeSet<>();
        final Map<Integer, SubscriptionInfo> infoById = new LinkedHashMap<>();
        final Map<Integer, Integer> slotById = new LinkedHashMap<>();
        final Map<Integer, Set<String>> sourcesById = new LinkedHashMap<>();
        final Map<String, Object> apiAttempts = new LinkedHashMap<>();
        final Map<String, Object> candidateChecks = new LinkedHashMap<>();
        final List<Map<String, Object>> slotScans = new ArrayList<>();
        final Map<String, Object> diagnostics = new LinkedHashMap<>();
        int defaultDataSubId = SubscriptionManager.INVALID_SUBSCRIPTION_ID;
        int activeDataSubId = SubscriptionManager.INVALID_SUBSCRIPTION_ID;
        int defaultSubId = SubscriptionManager.INVALID_SUBSCRIPTION_ID;
        int defaultVoiceSubId = SubscriptionManager.INVALID_SUBSCRIPTION_ID;
        int defaultSmsSubId = SubscriptionManager.INVALID_SUBSCRIPTION_ID;
        int baseTelephonySubId = SubscriptionManager.INVALID_SUBSCRIPTION_ID;
        Integer preferredSubId;
        String error;
    }

    private static final class LiveRadio {
        final List<Map<String, Object>> serving = new ArrayList<>();
        final List<Map<String, Object>> cells = new ArrayList<>();
        final List<Map<String, Object>> physicalChannels = new ArrayList<>();
        final Set<String> physicalLteCarrierKeys = new TreeSet<>();
        final Set<Integer> observedLte = new TreeSet<>();
        final Set<Integer> observedNr = new TreeSet<>();
        boolean cellReadSucceeded;
        boolean physicalReadSucceeded;
        int physicalLtePrimaryCount;
        int physicalLteSecondaryCount;
        String cellError;
        String physicalError;
    }

    private static final class BandDiscovery {
        final Set<Integer> servingLte = new TreeSet<>();
        final Set<Integer> servingNr = new TreeSet<>();
        final Set<Integer> observedLte = new TreeSet<>();
        final Set<Integer> observedNr = new TreeSet<>();
        final Set<Integer> selectionLte = new TreeSet<>();
        final Set<Integer> selectionNr = new TreeSet<>();
        final Set<Integer> allLte = new TreeSet<>();
        final Set<Integer> allNr = new TreeSet<>();

        Map<String, Object> json() {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("serving", pair(servingLte, servingNr));
            value.put("observed", pair(observedLte, observedNr));
            value.put("selection", pair(selectionLte, selectionNr));
            value.put("all", pair(allLte, allNr));
            return value;
        }

        Map<String, Object> catalogJson() {
            Map<String, Object> value = pair(allLte, allNr);
            value.put("source", "Runtime serving, observed, and current-selection data");
            value.put("dynamic", true);
            return value;
        }

        private static Map<String, Object> pair(
                Set<Integer> lte, Set<Integer> nr) {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("lte", new ArrayList<>(lte));
            value.put("nr", new ArrayList<>(nr));
            return value;
        }
    }

    private interface SubIdReader {
        int read();
    }

    private interface CountReader {
        int read();
    }

    private static final class CellReading {
        final String rat;
        final Integer band;
        final boolean registered;
        final int connectionStatus;
        final Integer channel;
        final Integer pci;
        final Integer bandwidthKhz;
        final Integer level;
        final Integer rsrp;
        final Integer rsrq;
        final Number sinr;

        CellReading(
                String rat, Integer band, boolean registered, int connectionStatus,
                Integer channel, Integer pci, Integer bandwidthKhz,
                Integer level, Integer rsrp, Integer rsrq, Number sinr) {
            this.rat = rat;
            this.band = band;
            this.registered = registered;
            this.connectionStatus = connectionStatus;
            this.channel = channel;
            this.pci = pci;
            this.bandwidthKhz = bandwidthKhz;
            this.level = level;
            this.rsrp = rsrp;
            this.rsrq = rsrq;
            this.sinr = sinr;
        }

        Map<String, Object> servingJson() {
            Map<String, Object> value = blankServing(
                    rat, band,
                    connectionStatus == CellInfo.CONNECTION_PRIMARY_SERVING
                            || (registered && connectionStatus != CellInfo.CONNECTION_SECONDARY_SERVING),
                    registered, channel, pci, bandwidthKhz);
            value.put("level", level);
            value.put("rsrp", rsrp);
            value.put("rsrq", rsrq);
            value.put("sinr", sinr);
            return value;
        }

        Map<String, Object> json() {
            Map<String, Object> value = servingJson();
            value.put("connectionStatus", connectionStatus);
            return value;
        }
    }
}
