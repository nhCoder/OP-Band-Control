package io.github.opband;

import android.content.Context;
import android.os.Looper;

import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

/** app_process entry point. Every response is a single JSON object on stdout. */
public final class Main {
    private Main() {}

    public static void main(String[] args) {
        int exitCode = 0;
        Map<String, Object> response;
        try {
            Command command = Command.parse(args);
            exemptHiddenApisBestEffort();
            ensureTelephonyFrameworkInitialized();
            prepareMainLooper();
            Context context = systemContext();
            TelephonyBackend backend = new TelephonyBackend(context);
            response = command.execute(backend);
        } catch (CommandException error) {
            response = error(error.code, error.getMessage(), null);
            exitCode = error.exitCode;
        } catch (Throwable error) {
            Throwable cause = unwrap(error);
            response = error(
                    "HELPER_FAILURE",
                    safeMessage(cause),
                    cause.getClass().getName());
            exitCode = 70;
        }

        try {
            System.out.println(Json.encode(response));
        } catch (Throwable jsonError) {
            System.out.println(
                    "{\"ok\":false,\"error\":{\"code\":\"JSON_FAILURE\","
                            + "\"message\":\"Could not encode response\"}}"
            );
            exitCode = 70;
        }
        System.out.flush();
        System.exit(exitCode);
    }

    private static Map<String, Object> error(String code, String message, String type) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("code", code);
        detail.put("message", message == null ? "Unknown error" : message);
        if (type != null) detail.put("type", type);
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("ok", false);
        root.put("error", detail);
        return root;
    }

    private static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while (current instanceof InvocationTargetException
                && ((InvocationTargetException) current).getCause() != null) {
            current = ((InvocationTargetException) current).getCause();
        }
        return current;
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) message = error.toString();
        message = message.replace('\n', ' ').replace('\r', ' ');
        return message.length() > 320 ? message.substring(0, 320) : message;
    }

    private static Context systemContext() throws Exception {
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Method systemMain = activityThread.getDeclaredMethod("systemMain");
        Object thread = systemMain.invoke(null);
        Method getSystemContext = activityThread.getDeclaredMethod("getSystemContext");
        Object context = getSystemContext.invoke(thread);
        if (!(context instanceof Context)) {
            throw new IllegalStateException("ActivityThread did not provide a system context");
        }
        return (Context) context;
    }

    /**
     * RuntimeInit invokes this command's main method directly, so it bypasses
     * ActivityThread.main(). Android 16 normally installs the telephony service
     * manager there before preparing the main Looper. systemMain() does not
     * repeat that process bootstrap.
     *
     * Without this call TelephonyFrameworkInitializer keeps a null
     * TelephonyServiceManager and otherwise valid TelephonyManager and
     * SubscriptionManager calls fail before reaching the phone/isub binders.
     */
    private static void ensureTelephonyFrameworkInitialized() throws Exception {
        Class<?> telephonyInitializer =
                Class.forName("android.telephony.TelephonyFrameworkInitializer");
        Method getTelephonyServiceManager =
                telephonyInitializer.getDeclaredMethod("getTelephonyServiceManager");
        getTelephonyServiceManager.setAccessible(true);
        synchronized (telephonyInitializer) {
            if (getTelephonyServiceManager.invoke(null) != null) return;

            // Initialize only telephony. OEM builds can add unrelated media,
            // stats, Bluetooth, NFC, or profiling work to ActivityThread's full
            // mainline bootstrap, none of which this bounded helper needs.
            Class<?> serviceManagerClass = Class.forName("android.os.TelephonyServiceManager");
            Constructor<?> constructor = serviceManagerClass.getDeclaredConstructor();
            constructor.setAccessible(true);
            Object serviceManager = constructor.newInstance();
            Method setTelephonyServiceManager = telephonyInitializer.getDeclaredMethod(
                    "setTelephonyServiceManager", serviceManagerClass);
            setTelephonyServiceManager.setAccessible(true);
            try {
                setTelephonyServiceManager.invoke(null, serviceManager);
            } catch (InvocationTargetException error) {
                // The setter is call-once. A concurrent/framework initializer
                // wins only if it actually installed the required manager.
                if (getTelephonyServiceManager.invoke(null) == null) throw error;
            }

            if (getTelephonyServiceManager.invoke(null) == null) {
                throw new IllegalStateException(
                        "Android telephony framework bootstrap returned no service manager");
            }
        }
    }

    /**
     * app_process calls an arbitrary Java main method through RuntimeInit without
     * preparing a main-thread MessageQueue. ActivityThread.systemMain() creates
     * Handler instances during construction, so it must run after this step.
     *
     * We intentionally do not enter Looper.loop(): this is a bounded command-line
     * helper, all telephony callbacks use their supplied Executor, and main() ends
     * with System.exit after callbacks are unregistered.
     */
    @SuppressWarnings("deprecation")
    private static void prepareMainLooper() {
        if (Looper.myLooper() == null) {
            Looper.prepareMainLooper();
        }
    }

    private static void exemptHiddenApisBestEffort() {
        try {
            Class<?> vmRuntimeClass = Class.forName("dalvik.system.VMRuntime");
            Method getRuntime = vmRuntimeClass.getDeclaredMethod("getRuntime");
            Object runtime = getRuntime.invoke(null);
            Method setExemptions =
                    vmRuntimeClass.getDeclaredMethod("setHiddenApiExemptions", String[].class);
            setExemptions.invoke(runtime, (Object) new String[] {"Landroid/", "Lcom/android/"});
        } catch (Throwable ignored) {
            // Telephony's SystemApi methods are often reflectable without an exemption.
        }
    }

    private static final class Command {
        final String verb;
        final Integer subId;
        final String lte;
        final String nr;
        final String restoreToken;

        private Command(String verb, Integer subId, String lte, String nr, String restoreToken) {
            this.verb = verb;
            this.subId = subId;
            this.lte = lte;
            this.nr = nr;
            this.restoreToken = restoreToken;
        }

        static Command parse(String[] args) throws CommandException {
            if (args.length == 0) throw usage("Missing command");
            String verb = args[0];
            switch (verb) {
                case "status":
                case "selection":
                case "reset":
                    if (args.length > 2) throw usage("Too many arguments for " + verb);
                    return new Command(
                            verb, args.length == 2 ? parseSubId(args[1]) : null,
                            null, null, null);
                case "apply":
                    if (args.length == 3) {
                        return new Command(verb, null, args[1], args[2], null);
                    }
                    if (args.length == 4) {
                        return new Command(verb, parseSubId(args[1]), args[2], args[3], null);
                    }
                    throw usage("apply expects [subId] <lteCsv|-> <nrCsv|->");
                case "restore":
                    // Internal lifecycle command. The controller never accepts an arbitrary token.
                    if (args.length != 3) throw usage("restore expects <subId> <token>");
                    return new Command(verb, parseSubId(args[1]), null, null, args[2]);
                default:
                    throw usage("Unknown command: " + verb);
            }
        }

        Map<String, Object> execute(TelephonyBackend backend) throws Exception {
            switch (verb) {
                case "status":
                    return backend.status(subId);
                case "selection":
                    return backend.selection(subId);
                case "apply":
                    return backend.apply(subId, lte, nr);
                case "reset":
                    return backend.reset(subId);
                case "restore":
                    return backend.restore(subId, restoreToken);
                default:
                    throw new AssertionError(verb);
            }
        }

        private static Integer parseSubId(String value) throws CommandException {
            if (value == null || !value.matches("[0-9]{1,10}")) {
                throw usage("Invalid subscription ID");
            }
            try {
                int parsed = Integer.parseInt(value);
                if (parsed < 0) throw new NumberFormatException();
                return parsed;
            } catch (NumberFormatException error) {
                throw usage("Invalid subscription ID");
            }
        }

        private static CommandException usage(String message) {
            return new CommandException(
                    "USAGE",
                    message + "; commands: status [subId], selection [subId], "
                            + "apply [subId] lteCsv|- nrCsv|-, reset [subId]",
                    64);
        }
    }

    static final class CommandException extends Exception {
        private static final long serialVersionUID = 1L;
        final String code;
        final int exitCode;

        CommandException(String code, String message, int exitCode) {
            super(message);
            this.code = code;
            this.exitCode = exitCode;
        }
    }
}
