# Fronteira Java

Este módulo é a primeira implementação Java do contrato canônico. Ele ainda
não substitui a API TypeScript nem acessa o PostgreSQL; sua função nesta fase é
provar que outra linguagem consegue validar o mesmo envelope e `payloadHash`.

Requisitos: Java 21 e Maven 3.9+.

```bash
mvn test
mvn spring-boot:run
```

Endpoints locais:

- `GET http://localhost:8080/v1/health/live`
- `POST http://localhost:8080/v1/events` com `Authorization: Bearer local-dev-token`

A persistência, idempotência e a paridade com o núcleo atual entram na Fase 8.
