# Новый Ubuntu-сервер для этапа 2

Инструкция поднимает чистый Ubuntu 24.04 (VirtualBox или сервер заказчика),
скачивает этот репозиторий с GitHub и запускает PostgreSQL, Redis и MinIO.

На этом этапе нет веб-интерфейса и поиска закупок. Успех — контейнеры
`healthy`, миграции применены, seed-профиль создан один раз.

---

## 1. Требования к машине

| Ресурс | Минимум | Рекомендуется |
|---|---|---|
| ОС | Ubuntu Server 24.04 LTS, 64-bit | то же |
| CPU | 2 ядра | 3–4 |
| RAM | 4 ГБ | 6 ГБ |
| Диск | 40 ГБ | 60 ГБ |
| Сеть | NAT или bridged | SSH с хоста |

15 ГБ диска недостаточно: образы PostgreSQL, Redis и MinIO не влезут.

---

## 2. Создать виртуальную машину (VirtualBox)

1. Скачайте ISO: [Ubuntu Server 24.04 LTS](https://ubuntu.com/download/server).
2. VirtualBox → **Создать**:
   - имя: `Ubuntu-server`
   - тип: Linux, Ubuntu 24.04 (64-bit)
   - память: не меньше 4096 МБ
   - процессоры: не меньше 2
   - диск: **не меньше 40 ГБ**, динамический VDI
3. Сеть: адаптер 1 = **NAT**.
4. Проброс портов NAT (чтобы заходить с Windows по SSH):

   | Имя | Протокол | Хост | Гость |
   |---|---|---|---|
   | ssh | TCP | 2222 | 22 |

5. Запустите ВМ и установите Ubuntu Server:
   - пользователь с правами `sudo`
   - OpenSSH server — включить
   - Docker из установщика Ubuntu **не** ставить, ниже отдельный шаг
6. После первой загрузки:

```bash
sudo apt update
sudo apt upgrade -y
```

С Windows:

```powershell
ssh -p 2222 ваш_логин@127.0.0.1
```

---

## 3. Поставить Docker и Node.js 22

```bash
sudo apt update
sudo apt install -y ca-certificates curl git

# Docker Engine + Compose plugin
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker "$USER"

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Выйдите из SSH и зайдите снова, иначе `docker` потребует `sudo`.

Проверка:

```bash
docker version
docker compose version
node -v    # должно быть v22.x
npm -v
```

---

## 4. Скачать проект с GitHub

```bash
cd "$HOME"
git clone https://github.com/Serhio348/procurement-ai-platform.git
cd procurement-ai-platform
git checkout main
git pull
cp .env.example .env
```

`.env` не коммитится. Для тестовой ВМ значения из примера можно оставить.
На сервере заказчика пароли PostgreSQL, Redis и MinIO замените.

---

## 5. Поднять инфраструктуру

```bash
cd ~/procurement-ai-platform
npm install
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
```

Ожидаемый результат:

- `postgres` — Up (healthy), порт `127.0.0.1:5432`
- `redis` — Up (healthy), порт `127.0.0.1:6379`
- `minio` — Up (healthy), порты `127.0.0.1:9000` и `9001`
- `minio-init` — Exited (0): одноразово создал bucket и остановился

Если порт 5432 уже занят:

```bash
# в .env
POSTGRES_PORT=55432
DATABASE_URL=postgres://procurement:procurement@127.0.0.1:55432/procurement
```

Затем снова `docker compose -f infra/docker-compose.yml up -d`.

---

## 6. Миграции и seed

```bash
set -a
source .env
set +a

npm run db:migrate
npm run db:bootstrap
npm run db:bootstrap   # второй раз: без дубля профиля
```

Профиль `electrical_equipment` создаётся один раз. Повторный bootstrap его
не перезаписывает.

---

## 7. Проверка

```bash
npm run verify
```

Дополнительно, на отдельной тестовой базе:

```bash
docker compose -f infra/docker-compose.yml exec postgres \
  createdb -U procurement procurement_stage2_test

TEST_DATABASE_URL="postgres://procurement:procurement@127.0.0.1:${POSTGRES_PORT:-5432}/procurement_stage2_test" \
  npm test -- packages/db/src/db.integration.test.ts
```

Если `POSTGRES_PORT` в `.env` не 5432, подставьте его в URL.

---

## 8. Остановка

Контейнеры и данные на диске ВМ сохраняются:

```bash
docker compose -f infra/docker-compose.yml down
```

Удалить и данные PostgreSQL/Redis/MinIO:

```bash
docker compose -f infra/docker-compose.yml down -v
```

---

## 9. Что пока нельзя проверить на этой ВМ

- веб-интерфейс
- Telegram-уведомления
- вход пользователя в платформу

Source-native поиск и публичные карточки этапа 4 можно проверить с белорусского
адреса через `RUN_GOSZAKUPKI_LIVE_TESTS=1`; для обычной разработки остаётся
`PROCUREMENT_SOURCE_MODE=fixture`.
