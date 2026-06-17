import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const existingCollections = await prisma.collection.count();

  if (existingCollections > 0) {
    return;
  }

  const environment = await prisma.environment.create({
    data: {
      name: "Local",
      active: true,
      variables: {
        create: [
          {
            key: "baseUrl",
            initialValue: "https://postman-echo.com",
            currentValue: "https://postman-echo.com",
            enabled: true,
            scope: "ENVIRONMENT",
            isSecret: false
          }
        ]
      }
    }
  });

  await prisma.variable.create({
    data: {
      key: "token",
      initialValue: "",
      currentValue: "",
      enabled: false,
      scope: "GLOBAL",
      isSecret: true
    }
  });

  await prisma.collection.create({
    data: {
      name: "Demo",
      variables: {
        create: [
          {
            key: "demoUserId",
            initialValue: "123",
            currentValue: "123",
            enabled: true,
            scope: "COLLECTION",
            isSecret: false
          }
        ]
      },
      requests: {
        create: [
          {
            name: "Echo GET",
            method: "GET",
            url: "{{baseUrl}}/get",
            headersJson: JSON.stringify([
              {
                key: "Accept",
                value: "application/json",
                enabled: true,
                isSecret: false
              }
            ]),
            queryParamsJson: JSON.stringify([
              {
                key: "userId",
                value: "{{demoUserId}}",
                enabled: true,
                isSecret: false
              }
            ]),
            bodyMode: "none",
            bodyRawFormat: "json",
            bodyRaw: "",
            authJson: JSON.stringify({ type: "none" })
          }
        ]
      }
    }
  });

  console.log(`Seeded PostRE with environment ${environment.name}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
