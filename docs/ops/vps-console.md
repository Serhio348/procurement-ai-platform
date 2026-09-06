ъ+_ёцй # Консоль на любом Ubuntu-сервере

Инструкция поднимает **живую консоль специалиста** на чистом сервере:
клиенты открывают ссылку в браузере, программа с белорусского IP ходит
на `goszakupki.by`.

Для домашнего VirtualBox без клиентов достаточно
[`ubuntu-server.md`](ubuntu-server.md) (только Docker и база).

Один сервер — одна фирма. Общего логина на всех заказчиков нет: у каждого
свой `.env` и своя база.

---

## 0. Что должно быть у сервера

| | Минимум |
|---|---|
| ОС | Ubuntu 22.04 или 24.04, 64-bit, **без** ISPmanager / FastPanel |
| CPU | 2 ядра |
| RAM | 4 ГБ |
| Диск | 50 ГБ |
| Сеть | публичный IPv4 **в Беларуси** (иначе площадка не пустит) |
| Доступ | SSH, пользователь `root` или свой с `sudo` |

Не ставьте на этот сервер VPN/прокси «для раздачи интернета» — у части
хостеров это запрещено. Консоль — обычное веб-приложение, это другое.

Имя хоста в панели (`zakupki`) — кличка сервера, не сайт. Клиентам
потом даёте IP или домен.

---

## 1. Первый вход по SSH

С Windows (PowerShell или cmd), подставьте IP хостера:

```powershell
ssh root@193.47.42.49
```

Первый раз спросит `Are you sure you want to continue connecting` —
напишите `yes` и Enter. Пароль от хостера: буквы не рисуются, так надо.

Дальше все команды — **на сервере**, в этом SSH. Если вы не `root`,
добавьте `sudo` перед `apt`, `systemctl`, правкой файлов в `/etc`.

Проверка, что вы внутри:

```bash
hostname
whoami
```

Ожидание: имя вроде `zakupki`, пользователь `root`.

---

## 2. Система: Docker, Node.js 22, nginx

Обновить списки пакетов и поставить то, без чего дальше нельзя:

```bash
apt update
apt install -y ca-certificates curl git nginx apache2-utils
```

| Пакет | Зачем |
|---|---|
| `ca-certificates` | проверка HTTPS |
| `curl` | скачать ключи Docker и Node |
| `git` | клон с GitHub |
| `nginx` | вход с улицы: порт 80, статика и прокси `/api` |
| `apache2-utils` | не обязателен, пока нет пароля nginx |

### 2.1. Docker Engine и Compose

Официальный репозиторий Docker (не snap):

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

Если работаете не под `root`:

```bash
usermod -aG docker "$USER"
```

После `usermod` выйдите из SSH и зайдите снова, иначе `docker` будет
просить `sudo`.

### 2.2. Node.js 22

В проекте нужен Node **22+** и **npm** (не pnpm, не yarn):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
```

### 2.3. Проверка

```bash
docker version
docker compose version
node -v
npm -v
```

Ожидание: Docker без ошибки, `v22.…`, любой свежий `npm`.

---

## 3. Скачать проект с GitHub

Репозиторий закрытый. Нужен доступ вашего GitHub-аккаунта.

**Токен (один раз на компьютере разработчика):**  
GitHub → Settings → Developer settings → Personal access tokens →
classic token с правом `repo`. Пароль от сайта GitHub в `git clone`
**не** подходит.

На сервере:

Проект живёт в `/opt`, не в `/root`: nginx не читает домашнюю папку root.

```bash
git clone git@github.com:Serhio348/procurement-ai-platform.git /opt/procurement-ai-platform
cd /opt/procurement-ai-platform
git checkout main
cp .env.example .env
```

Логин — аккаунт GitHub. «Password» — токен (символы не видны).

Проверка:

```bash
pwd
git log -1 --oneline
```

Ожидание: путь `.../procurement-ai-platform`, последний коммит `main`.

---

## 4. Файл `.env`

Открыть редактор:

```bash
nano /opt/procurement-ai-platform/.env
```

`Ctrl+O` — сохранить, Enter, `Ctrl+X` — выход.

`.env` **никогда не коммитить**. Секреты в чат не слать.

Обязательно поменять для живой консоли:

```env
PROCUREMENT_SOURCE_MODE=live
GOSZAKUPKI_TLS_INSECURE=1
LLM_API_KEY=вставьте_свой_ключ_deepseek
```

| Переменная | Что значит |
|---|---|
| `PROCUREMENT_SOURCE_MODE=live` | поиск на goszakupki.by, не фикстуры |
| `GOSZAKUPKI_TLS_INSECURE=1` | на части Linux цепочка сертификатов площадки не сходится; без этого поиск пишет «площадка недоступна». На публичном сервере это компромисс, не оставляйте `NODE_TLS_REJECT_UNAUTHORIZED=0` |
| `LLM_API_KEY` | ключ DeepSeek, тот же что локально |
| `AUTH_BOOTSTRAP_EMAIL` / `AUTH_BOOTSTRAP_PASSWORD` | первый администратор, если таблица пользователей пуста |
| `AUTH_PUBLIC_URL` | адрес консоли в ссылке сброса пароля, например `http://193.47.42.49` |
| `AUTH_COOKIE_SECURE=0` | пока консоль на HTTP. После TLS поставьте `1` |
| `INTERNAL_API_TOKEN` | служебный заголовок для `POST /api/inbox/events` |

Остальное из примера можно оставить на первом стенде
(`DATABASE_URL`, MinIO, Redis). На сервере заказчика смените пароли
Postgres и MinIO в `.env` **до** первого `docker compose up`.

Проверка, что live включён:

```bash
grep PROCUREMENT_SOURCE_MODE /opt/procurement-ai-platform/.env
```

Ожидание: `live`, не `fixture`.

---

## 5. Пакеты Node, инфраструктура, миграции

В каталоге проекта:

```bash
cd /opt/procurement-ai-platform
npm install --include=dev
```

`--include=dev` нужен: без devDependencies не будет `concurrently`,
сборки и `tsx`.

Сборка пакетов (API импортирует `dist` у Document MCP):

```bash
npm run build
npm run build -w @procurement/web
```

Поднять PostgreSQL, Redis, MinIO. Порты только на `127.0.0.1` — с улицы
база не торчит:

```bash
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
```

Ожидание: `postgres`, `redis`, `minio` — `healthy`. `minio-init` —
`Exited (0)`.

Подгрузить `.env` в текущую оболочку и применить схему:

```bash
set -a
source /opt/procurement-ai-platform/.env
set +a
npm run db:migrate
npm run db:bootstrap
```

`db:bootstrap` второй раз профиль не дублирует.

---

После миграции `0002_auth` API при старте создаёт первого admin из
`AUTH_BOOTSTRAP_*`, если пользователей ещё нет. Пароль в логи не пишется.

## 6. nginx: с улицы только порт 80

Консоль теперь с логином внутри программы. Nginx по-прежнему только
отдаёт статику и проксирует `/api`. Cookie сессии `SameSite=Lax`,
`Secure` выключен на HTTP (`AUTH_COOKIE_SECURE=0`). Когда появится
HTTPS — поставьте `1` и перезапустите API.
Пока его нет, кто знает IP — откроет консоль. Для теста так и задумано.

Консоль — статика из `apps/web/dist`. Запросы `/api` идут на Fastify
`127.0.0.1:3001`. Vite на 5173 клиентам не открываем.

Конфиг лежит в репозитории: `infra/nginx/procurement.conf`.
Каталог сайта в нём — `/opt/procurement-ai-platform/apps/web/dist`.

```bash
cp /opt/procurement-ai-platform/infra/nginx/procurement.conf /etc/nginx/sites-available/procurement
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/procurement /etc/nginx/sites-enabled/procurement
nginx -t
systemctl reload nginx
```

Ожидание `nginx -t`: `syntax is ok`, `test is successful`.

---

## 8. Автозапуск API после перезагрузки

API слушает только `127.0.0.1:3001`. С улицы его не видно.
Юнит лежит в `infra/systemd/procurement-api.service`.
Процесс идёт от пользователя `procurement`, каталог — `/opt/procurement-ai-platform`.

```bash
id procurement || useradd --system --home /opt/procurement-ai-platform --shell /usr/sbin/nologin procurement
chown -R procurement:procurement /opt/procurement-ai-platform
chmod o+x /opt/procurement-ai-platform /opt/procurement-ai-platform/apps /opt/procurement-ai-platform/apps/web
chmod -R o+rX /opt/procurement-ai-platform/apps/web/dist
cp /opt/procurement-ai-platform/infra/systemd/procurement-api.service /etc/systemd/system/procurement-api.service
systemctl daemon-reload
systemctl enable --now procurement-api
systemctl status procurement-api --no-pager
```

В статусе — `active (running)`. В логе через минуту:

```bash
journalctl -u procurement-api -n 40 --no-pager
```

Ожидание: `Specialist API listening`, `"searchMode":"live"`,
`"postgres":true`, `"objectStore":"s3"`.

Если порт занят или красный traceback — пришлите этот лог, не угадывайте.

Перезапуск API после правки `.env`:

```bash
systemctl restart procurement-api
```

---

## 9. Файрвол: с улицы только SSH и сайт

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw --force enable
ufw status
```

Порты 3001, 5173, 5432, 6379, 9000 наружу не открывать.

---

## 10. Что дать клиенту

1. Ссылка: `http://IP-сервера` (пример: `http://193.47.42.49`).
2. Коротко: открыть ссылку → профиль → поиск.

Не давать: SSH, пароль `root`, токен GitHub, ключ DeepSeek.

Браузер может ругаться, что нет HTTPS — для первого теста это нормально.
Сертификат и домен — отдельный шаг (не в этой инструкции).

Проверка с телефона **не** по Wi‑Fi офиса, а с мобильного интернета:
открыть ту же ссылку. Если видна консоль — сервер доступен из Беларуси.

---

## 11. Обновить программу с GitHub

На сервере:

```bash
cd /opt/procurement-ai-platform
git pull
npm install --include=dev
npm run build
npm run build -w @procurement/web
set -a
source .env
set +a
npm run db:migrate
systemctl restart procurement-api
```

Статику nginx подхватит из `apps/web/dist` сразу после `build` web.
Если страница «старая» — жёсткое обновление в браузере (Ctrl+F5).

Конфликт `package-lock.json` после `npm install` на сервере:

```bash
git checkout -- package-lock.json
git pull
```

### 11.1. Этот раз: вход в консоль (этап 26)

После `git pull` консоль без логина больше не откроется. Сделайте шаги
по порядку, не пропускайте миграцию и переменные в `.env`.

**1. Код**

```bash
cd /opt/procurement-ai-platform
git config --global --add safe.directory /opt/procurement-ai-platform
git pull
```

**2. Первый администратор в `.env`**

```bash
nano /opt/procurement-ai-platform/.env
```

Добавьте в конец (подставьте свой email, пароль не короче 8 символов и IP сервера):

```env
AUTH_BOOTSTRAP_EMAIL=вы@ваша-фирма.by
AUTH_BOOTSTRAP_PASSWORD=придумайте-надежный-пароль
AUTH_PUBLIC_URL=http://193.47.42.49
AUTH_COOKIE_SECURE=0
INTERNAL_API_TOKEN=
```

`AUTH_COOKIE_SECURE=0` пока сайт на HTTP. SMTP для сброса пароля можно
не заполнять: вход и регистрация работают без почты.

Сохранить: `Ctrl+O`, Enter, `Ctrl+X`.

**3. Пакеты, миграция пользователей, сборка**

```bash
cd /opt/procurement-ai-platform
npm install --include=dev
set -a
source .env
set +a
npm run db:migrate
npm run build
npm run build -w @procurement/web
```

Ожидание миграции: в выводе нет ошибки, в базе появляются `auth_users`.

**4. Права и перезапуск API**

```bash
chown -R procurement:procurement /opt/procurement-ai-platform
systemctl restart procurement-api
```

**5. Проверка в браузере**

Откройте `http://IP` и нажмите **Ctrl+F5**. Должен быть тёмный экран
«Платформа закупок» и форма входа, не список закупок.

Войдите email и паролем из `AUTH_BOOTSTRAP_*`. Если таблица пользователей
уже была непустая, bootstrap admin не создастся — тогда зарегистрируйтесь
и выдайте себе роль вручную в базе или очистите `auth_users` только на
пустом стенде.

Другие сотрудники: «Регистрация» → ждут → вы в **Администрирование**
одобряете и ставите роль.

---

## 12. Обычные команды

| Задача | Команда |
|---|---|
| Лог API | `journalctl -u procurement-api -f` |
| Перезапуск API | `systemctl restart procurement-api` |
| Статус контейнеров | `cd /opt/procurement-ai-platform && docker compose -f infra/docker-compose.yml ps` |
| Перезапуск базы | `docker compose -f infra/docker-compose.yml restart` |
| Проверка nginx | `nginx -t && systemctl reload nginx` |

---

## 13. Если сломалось

**SSH не пускает.** Сервер ещё создаётся (подождать) или неверный пароль
хостера.

**`git clone` 403 / Authentication failed.** Нужен токен `repo`, не пароль
GitHub.

**Поиск: «Площадка goszakupki.by сейчас недоступна».**  
В `.env` есть `PROCUREMENT_SOURCE_MODE=live` и `GOSZAKUPKI_TLS_INSECURE=1`?
API перезапущен? С сервера:

```bash
curl -I --max-time 20 https://goszakupki.by
```

Если и `curl` не 200 — IP не белорусский или площадка лежит.

**Консоль без стилей / 404.** Не собран web: `npm run build -w @procurement/web`.
Путь `root` в nginx совпадает с `apps/web/dist`.

**502 Bad Gateway.** API не запущен: `systemctl status procurement-api`.

**Пустая страница / нет связи с API.** В логе API нет `listening` —
смотреть `journalctl`. Часто забыли `npm run build` или Docker не поднялся.

**После перезагрузки сервера нет базы.** Docker должен быть `enabled`
(ставится с пакетом). Затем `systemctl start procurement-api`.

---

## 14. Чего эта инструкция не делает

- HTTPS и домен `.by` (логин уже есть; Secure-cookie после TLS)
- входящий Telegram-бот
- документы на «Отслеживать» (качаются только после «Участвовать»)
- Railway / Cloudflare / домашний 4G как замена белорусскому IP
