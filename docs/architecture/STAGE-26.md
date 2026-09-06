# Этап 26 — вход в консоль и одобрение доступа

**Статус:** консоль закрыта сессией. Регистрация открытая, доступ
появляется только после одобрения администратором. Supabase не
подключали: пользователи живут в уже стоящем PostgreSQL.

---

## 1. Цель

С улицы нельзя читать закупки. Сотрудник сам создаёт аккаунт, admin
выдаёт роль на вкладке «Администрирование». Извещение о заявке — только
счётчик в меню, без письма и Telegram.

---

## 2. Архитектурное решение

```text
index.html (тёмный кабинет)
  → GET /api/auth/session
      нет cookie → /login | /register
      pending / rejected / revoked → экран ожидания
      active → консоль

POST /api/auth/sign-up
  → auth_users(access_status=pending, role=null)
  → cookie session
  → рабочие /api/* = 403

Admin → POST /api/admin/users/:id/approve { role }
  → access_status=active
```

- Сессия: httpOnly cookie `procurement.sid`, токен в базе как sha256,
  срок **сутки** — и cookie, и `expires_at`. Не скользящая.
- Пароль: scrypt. Роль с клиента при регистрации отбрасывается.
- Тесты API без каталога получают встроенную сессию specialist, чтобы
  не требовать Docker.
- Нет PostgreSQL — каталог пользователей в памяти процесса (как workspace
  JSON). Первый admin — `AUTH_BOOTSTRAP_*`, только если таблица пуста.
- `POST /api/inbox/events` при заданном `INTERNAL_API_TOKEN` не требует
  cookie.

Better Auth не подключали: тесты и `npm run web` без Postgres должны
остаться живыми, Fastify `inject()` — без Fetch-адаптера. Контракт тот
же: email/пароль, cookie, открытая регистрация, admin ставит роль.

---

## 3. Почему именно так

**Доступ ≠ регистрация.** Спам-аккаунт на публичном IP не видит кейсы.

**Роль считает код.** `consoleCapability` в domain: pending всегда
`none`, даже если в записи случайно стоит `admin`.

**Последний admin неприкосновенен.** Отзыв или смена роли, после которой
не остаётся активного admin, даёт `409 last_admin`.

**Первый кадр деловой.** Пока грузится JS, HTML уже рисует тёмный фон и
знак консоли. Не белая вспышка и не «Нет связи с API».

---

## 4. Изменения

- контракты `AuthSignUpWrite`, `AuthSessionUser`, `AdminUser`;
- таблицы `auth_users`, `auth_sessions`, `auth_password_resets`;
- шлюз Fastify по cookie и роли;
- вкладка «Администрирование» со счётчиком `pendingUserCount`;
- SMTP только для сброса пароля.

---

## 5. Новые файлы

```text
packages/contracts/src/auth.ts
packages/domain/src/auth/access.ts
packages/db/drizzle/0002_auth.sql
apps/api/src/auth/*
apps/web/src/auth/*
apps/web/src/admin/AdminApp.tsx
docs/architecture/STAGE-26.md
```

---

## 6. Изменения БД

- `auth_users(id, email, name, password_hash, role, access_status, …)`
- `auth_sessions(id, user_id, token_hash, expires_at)`
- `auth_password_resets(id, user_id, token_hash, expires_at)`

---

## 7. Критерии приёмки

- [x] без сессии `/api/procurements` отвечает 401;
- [x] регистрация создаёт `pending` без роли;
- [x] pending не читает inbox;
- [x] viewer читает и не запускает поиск;
- [x] admin одобряет заявку и видит счётчик;
- [x] первый кадр входа в палитре консоли;
- [x] `npm run verify` без живой площадки.
