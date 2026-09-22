import { hash } from '@node-rs/argon2';

const ARGON2_OPTIONS = {
  algorithm: 2 as any,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

async function main() {
  const pwd = await hash('admin1234', ARGON2_OPTIONS);
  console.log(pwd);
  process.exit(0);
}

main().catch(console.error);
