package ru.sphere.stock.infra;

import io.swagger.v3.oas.annotations.media.Schema;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Единственный источник времени в системе (ТЗ 4.1, 6.12). Время устройства не используется.
 *
 * <p>Режимы: реальный и демо (скорость ×1/×60/×600, пауза, перемотка вперёд). Назад время не идёт
 * никогда: журнал упорядочен по времени. Точность — микросекунды, как у timestamptz в Postgres,
 * чтобы хэш-цепочка сходилась после чтения из базы.
 */
@Component
public class AppClock {

    public enum Mode {
        REAL,
        SIM
    }

    @Schema(name = "ClockState")
    public record State(Mode mode, int speed, boolean paused, Instant simAnchor, Instant realAnchor) {
    }

    private final JdbcClient jdbc;
    private volatile State state;

    public AppClock(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void reload() {
        this.state = jdbc.sql("SELECT mode, speed, paused, sim_anchor, real_anchor FROM clock_state WHERE id = 1")
                .query((rs, n) -> new State(Mode.valueOf(rs.getString(1)), rs.getInt(2), rs.getBoolean(3),
                        toInstant(rs.getTimestamp(4)), toInstant(rs.getTimestamp(5))))
                .optional()
                .orElse(new State(Mode.REAL, 1, false, null, null));
    }

    public Instant now() {
        State s = state();
        Instant real = Instant.now();
        Instant t;
        if (s.mode() == Mode.REAL) {
            t = real;
        } else if (s.paused()) {
            t = s.simAnchor();
        } else {
            long elapsed = Duration.between(s.realAnchor(), real).toMillis();
            t = s.simAnchor().plusMillis(elapsed * s.speed());
        }
        return t.truncatedTo(ChronoUnit.MICROS);
    }

    public State state() {
        if (state == null) {
            reload();
        }
        return state;
    }

    /** Включить демо-часы: время продолжается с текущего момента, дальше — с ускорением. */
    @Transactional
    public synchronized State configure(int speed, boolean paused) {
        if (speed <= 0 || speed > 3600) {
            throw ApiException.badRequest("Скорость часов — от 1 до 3600");
        }
        persist(new State(Mode.SIM, speed, paused, now(), Instant.now()));
        return state;
    }

    /** Перемотка вперёд в демо-режиме. */
    @Transactional
    public synchronized State advance(Duration d) {
        if (d.isNegative() || d.isZero()) {
            throw ApiException.badRequest("Время идёт только вперёд");
        }
        State s = state();
        if (s.mode() != Mode.SIM) {
            throw ApiException.badRequest("Перемотка доступна только в демо-часах");
        }
        persist(new State(Mode.SIM, s.speed(), s.paused(), now().plus(d), Instant.now()));
        return state;
    }

    /** Вернуться к реальному времени — только если демо-время не убежало вперёд реального. */
    @Transactional
    public synchronized State real() {
        if (now().isAfter(Instant.now())) {
            throw ApiException.badRequest("Демо-время впереди реального: назад время не идёт. Дождитесь или сбросьте демо.");
        }
        persist(new State(Mode.REAL, 1, false, null, null));
        return state;
    }

    /** Полный сброс (только вместе со сбросом демо-данных). */
    @Transactional
    public synchronized void reset(Instant simStart, int speed) {
        persist(new State(Mode.SIM, speed, false, simStart, Instant.now()));
    }

    private void persist(State s) {
        jdbc.sql("UPDATE clock_state SET mode = ?, speed = ?, paused = ?, sim_anchor = ?, real_anchor = ? WHERE id = 1")
                .params(s.mode().name(), s.speed(), s.paused(), ts(s.simAnchor()), ts(s.realAnchor()))
                .update();
        this.state = s;
    }

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    private static Instant toInstant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
