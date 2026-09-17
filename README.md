# ESP32 Self-Programmable Backend

Cleaned and reorganized backend based on the existing project source.

## Structure

```text
backend/
├── src/
│   ├── config/
│   │   ├── db.ts
│   │   ├── env.ts
│   │   └── mqtt.ts
│   ├── controllers/
│   │   ├── common.ts
│   │   ├── authController.ts
│   │   ├── deviceController.ts
│   │   ├── sensorController.ts
│   │   ├── actuatorController.ts
│   │   ├── automationController.ts
│   │   ├── eventController.ts
│   │   ├── aiController.ts
│   │   └── index.ts
│   ├── middleware/
│   ├── models/
│   ├── routes/
│   ├── services/
│   ├── types/
│   ├── utils/
│   ├── validations/
│   ├── app.ts
│   └── server.ts
├── .env.example
├── package.json
└── tsconfig.json
```

## Local setup

```powershell
copy .env.example .env
npm install
npm run check
npm run build
npm run dev
```

The project uses native Node ESM (`NodeNext`), so local relative imports use `.js` specifiers.
