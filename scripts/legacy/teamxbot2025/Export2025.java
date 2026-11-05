package electrical.report;

import java.io.File;
import java.lang.reflect.Method;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.Supplier;

import com.fasterxml.jackson.databind.ObjectMapper;

import competition.electrical_contract.Contract2023;
import competition.electrical_contract.Contract2024;
import competition.electrical_contract.Contract2025;
import competition.electrical_contract.ElectricalContract;
import competition.electrical_contract.RoboxContract;
import xbot.common.injection.electrical_contract.CANBusId;
import xbot.common.injection.electrical_contract.CANMotorControllerInfo;
import xbot.common.injection.electrical_contract.DeviceInfo;
import xbot.common.injection.electrical_contract.IMUInfo;
import xbot.common.injection.swerve.SwerveInstance;

/**
 * One-off exporter for the 2025 season repo: writes each robot's contract as a JSON
 * snapshot in the electrical web tool's format. Kept in electrical-contract-web
 * (scripts/legacy/teamxbot2025); copy it into a TeamXbot2025 checkout to run it.
 *
 * The 2025 library has no PDH or power-source data, so snapshots carry only CAN devices
 * and DIO/PWM channels. Readiness comes from each getter's isXReady() method.
 *
 * Usage: Export2025 OUT_DIR   (writes &lt;ContractToUse&gt;.json and index.json)
 */
public final class Export2025 {

    record Robot(String robotName, Supplier<ElectricalContract> create) {}

    /** Same names as the ContractToUse switch in competition.Robot (2025 repo). */
    static final Map<String, Robot> CONTRACTS = new LinkedHashMap<>();

    static {
        CONTRACTS.put("Competition", new Robot("2025 Competition", Contract2025::new));
        CONTRACTS.put("2024", new Robot("2024 Robot", Contract2024::new));
        CONTRACTS.put("2023", new Robot("2023 Robot", Contract2023::new));
        CONTRACTS.put("Robox", new Robot("Robox", RoboxContract::new));
    }

    /** Getters whose readiness method isn't simply is&lt;Name&gt;Ready(). */
    static final Map<String, String> READY = Map.of(
            "getAlgaeCollectionMotor", "isAlgaeCollectionReady",
            "getCoralArmPivotMotor", "isCoralArmMotorReady",
            "getElevatorMotor", "isElevatorReady");

    /** DeviceInfo getters that are CAN devices (default bus RIO), with their type. */
    static final Map<String, String> CAN_DEVICE_INFO = Map.of("getElevatorDistanceSensor", "LaserCAN");

    static final List<String> SWERVE = List.of("FrontLeftDrive", "FrontRightDrive", "RearLeftDrive", "RearRightDrive");

    private Export2025() {}

    public static void main(String[] args) throws Exception {
        File dir = new File(args.length > 0 ? args[0] : "out");
        dir.mkdirs();
        String sha = gitSha();
        List<Map<String, Object>> index = new ArrayList<>();
        for (var e : CONTRACTS.entrySet()) {
            Map<String, Object> snap = snapshot(e.getKey(), e.getValue(), sha);
            String file = e.getKey() + ".json";
            new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(new File(dir, file), snap);
            index.add(Map.of("name", e.getKey(), "file", file));
            System.out.printf("%-12s %2d CAN, %d DIO, %d PWM, %d not on this robot%n", e.getKey(),
                    ((List<?>) snap.get("canDevices")).size(), ((List<?>) snap.get("dio")).size(),
                    ((List<?>) snap.get("pwm")).size(), ((java.util.Collection<?>) snap.get("disabled")).size());
        }
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("gitSha", sha);
        root.put("generatedAt", Instant.now().toString());
        root.put("contracts", index);
        new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(new File(dir, "index.json"), root);
    }

    static Map<String, Object> snapshot(String contractName, Robot robot, String sha) throws Exception {
        ElectricalContract c = robot.create().get();
        List<Map<String, Object>> can = new ArrayList<>();
        List<Map<String, Object>> dio = new ArrayList<>();
        List<Map<String, Object>> pwm = new ArrayList<>();
        TreeSet<String> disabled = new TreeSet<>();

        for (Method m : c.getClass().getMethods()) {
            if (m.getParameterCount() != 0 || !m.getName().startsWith("get")) {
                continue;
            }
            Class<?> rt = m.getReturnType();
            if (rt != CANMotorControllerInfo.class && rt != DeviceInfo.class && rt != IMUInfo.class) {
                continue;
            }
            Object value = m.invoke(c);
            if (value == null) {
                continue;
            }
            String owner = m.getDeclaringClass().getSimpleName();
            boolean ready = isReady(c, m.getName());
            if (value instanceof CANMotorControllerInfo motor) {
                if (!ready) {
                    disabled.add(motor.name());
                } else {
                    can.add(canDevice(motor.name(), motor.busId(), motor.deviceId(), String.valueOf(motor.type()), "motor", owner));
                }
            } else if (value instanceof DeviceInfo d) {
                if (!ready) {
                    disabled.add(d.name);
                } else if (CAN_DEVICE_INFO.containsKey(m.getName())) {
                    can.add(canDevice(d.name, d.canBusId, d.channel, CAN_DEVICE_INFO.get(m.getName()), "can_sensor", owner));
                } else {
                    String lower = m.getName().toLowerCase();
                    (lower.contains("servo") || lower.contains("pwm") ? pwm : dio).add(channel(d.name, d.channel, owner));
                }
            } else if (value instanceof IMUInfo imu && imu.canBusId() != null && ready) {
                can.add(canDevice(imu.name(), imu.canBusId(), imu.deviceId(), String.valueOf(imu.imuType()), "can_sensor", owner));
            }
        }

        // Swerve modules: getters take a SwerveInstance.
        String owner = declaring(c, "getDriveMotor", SwerveInstance.class);
        for (String label : SWERVE) {
            SwerveInstance s = new SwerveInstance(label);
            for (CANMotorControllerInfo motor : List.of(c.getDriveMotor(s), c.getSteeringMotor(s))) {
                if (motor == null) {
                    continue;
                }
                if (c.isDriveReady()) {
                    can.add(canDevice(motor.name(), motor.busId(), motor.deviceId(), String.valueOf(motor.type()), "motor", owner));
                } else {
                    disabled.add(motor.name());
                }
            }
            DeviceInfo enc = c.getSteeringEncoder(s);
            if (enc != null) {
                if (c.areCanCodersReady()) {
                    can.add(canDevice(enc.name, enc.canBusId, enc.channel, "CANCoder", "can_sensor",
                            declaring(c, "getSteeringEncoder", SwerveInstance.class)));
                } else {
                    disabled.add(enc.name);
                }
            }
        }
        can.sort(Comparator.comparing((Map<String, Object> d) -> (String) d.get("bus")).thenComparing(d -> (Integer) d.get("canId")));
        dio.sort(Comparator.comparing(d -> (Integer) d.get("channel")));
        pwm.sort(Comparator.comparing(d -> (Integer) d.get("channel")));

        Map<String, Object> root = new LinkedHashMap<>();
        root.put("source", c.getClass().getName());
        root.put("contractName", contractName);
        root.put("robotName", robot.robotName());
        root.put("gitSha", sha);
        root.put("generatedAt", Instant.now().toString());
        root.put("canDevices", can);
        root.put("dio", dio);
        root.put("pwm", pwm);
        root.put("additionalPdh", new TreeMap<>());
        root.put("powerSources", new TreeMap<>());
        root.put("powerBranches", new TreeMap<>());
        root.put("canOrder", List.of());
        root.put("warnings", List.of("2025 library: no PDH or power-source data in the contract; one-off export"));
        root.put("disabled", disabled);
        return root;
    }

    static boolean isReady(ElectricalContract c, String getter) throws Exception {
        String name = READY.getOrDefault(getter, "is" + getter.substring(3) + "Ready");
        try {
            return (Boolean) c.getClass().getMethod(name).invoke(c);
        } catch (NoSuchMethodException e) {
            return true; // no readiness method: always on (lights, IMU)
        }
    }

    static String declaring(ElectricalContract c, String name, Class<?>... params) {
        try {
            return c.getClass().getMethod(name, params).getDeclaringClass().getSimpleName();
        } catch (NoSuchMethodException e) {
            return null;
        }
    }

    static Map<String, Object> canDevice(String name, CANBusId bus, int id, String type, String kind, String owner) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", name);
        m.put("bus", bus == null ? "rio" : "*".equals(bus.id()) ? "Canivore" : bus.id());
        m.put("canId", id);
        m.put("type", type);
        m.put("kind", kind);
        m.put("pdhPort", null);
        m.put("powerFrom", null);
        m.put("busPosition", null);
        m.put("definedIn", owner);
        return m;
    }

    static Map<String, Object> channel(String name, int ch, String owner) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", name);
        m.put("channel", ch);
        m.put("powerFrom", null);
        m.put("definedIn", owner);
        return m;
    }

    static String gitSha() {
        try {
            Process p = new ProcessBuilder("git", "rev-parse", "HEAD").redirectErrorStream(true).start();
            String s = new String(p.getInputStream().readAllBytes()).trim();
            return p.waitFor() == 0 ? s : null;
        } catch (Exception e) {
            return null;
        }
    }
}
