# Сервер склада для VPS: собранный jar + собранный интерфейс (его отдаёт сам Spring, stock.web-dir).
# Собирать не здесь: deploy.sh кладёт рядом stock.jar и web/ из backend и frontend.
FROM eclipse-temurin:25-jre

WORKDIR /app
COPY stock.jar /app/stock.jar
COPY web /app/web

ENV WEB_DIR=/app/web \
    UPLOADS_DIR=/data/uploads \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=60 -Dstdout.encoding=UTF-8"
VOLUME /data
EXPOSE 8080

# Без curl и wget (в образе их может не быть): запрос к /actuator/health через bash /dev/tcp
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /actuator/health HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q UP <&3"]

ENTRYPOINT ["java", "-jar", "/app/stock.jar"]
