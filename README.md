# СЗЗ Инструмент — деплой на Firebase

## Быстрый старт (5 шагов)

### 1. Установи Firebase CLI
```bash
npm install -g firebase-tools
firebase login
```

### 2. Установи зависимости функций
```bash
cd functions
npm install
cd ..
```

### 3. Деплой всего одной командой
```bash
firebase deploy
```

Сайт будет на: **https://szz-project.web.app**

---

## Что уже настроено

✅ Firebase конфиг вставлен (проект `szz-project`)  
✅ `.firebaserc` настроен на твой проект  
✅ Анонимный вход — никакой регистрации, каждый браузер получает свою сессию  
✅ Проекты хранятся в Firestore (публичные — видны всем)  
✅ Изображения/логотипы в Firebase Storage  
✅ Прокси для ПКК — Cloud Function, никакого Python локально  

## Что нужно включить в Firebase Console

Открой https://console.firebase.google.com → проект `szz-project`:

| Сервис | Действие |
|--------|----------|
| Authentication | Build → Authentication → Get started → Anonymous → Enable |
| Firestore | Build → Firestore → Create database → Production mode → europe-west |
| Storage | Build → Storage → Get started → Production mode |
| Functions | Build → Functions → Get started (нужен план Blaze) |
| Hosting | Build → Hosting → Get started |

## Правила безопасности

После деплоя в Firebase Console проверь что правила применились:

**Firestore** (`firestore.rules`) — публичное чтение/запись  
**Storage** (`storage.rules`) — только изображения до 10MB

## Структура
```
szz-firebase/
├── public/          ← сайт (HTML/CSS/JS)
├── functions/       ← прокси для ПКК (Cloud Function)
├── firebase.json    ← конфиг деплоя
├── .firebaserc      ← project: szz-project
├── firestore.rules  ← правила БД
└── storage.rules    ← правила хранилища
```
