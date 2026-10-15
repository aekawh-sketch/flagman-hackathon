package ru.sphere.stock.redis;

import java.util.concurrent.Executors;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.support.TaskExecutorAdapter;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;

/**
 * Подписки Redis Pub/Sub. Сессии сотрудников (Spring Session) и подключение настраивает Spring Boot
 * по {@code spring.data.redis.*} и {@code spring.session.*} в application.yml.
 */
@Configuration
@ConditionalOnProperty(name = "stock.redis.enabled", havingValue = "true", matchIfMissing = true)
class RedisConfig {

    /** Имя — как у контейнера Spring Boot: свой заменяет его (у того сообщения разбираются параллельно). */
    @Bean
    RedisMessageListenerContainer redisMessageListenerContainer(RedisConnectionFactory connections) {
        RedisMessageListenerContainer c = new RedisMessageListenerContainer();
        c.setConnectionFactory(connections);
        // Сообщения — по одному, по порядку: события склада приходят в браузер в той же очерёдности, что и случились
        c.setTaskExecutor(new TaskExecutorAdapter(Executors.newSingleThreadExecutor(
                Thread.ofVirtual().name("redis-events").factory())));
        return c;
    }
}
