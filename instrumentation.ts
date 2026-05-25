export async function register() {
  // BigInt 无法被 JSON.stringify 序列化，Prisma 返回的 BigInt 字段
  // 经过 NextResponse.json() 时会抛 "Do not know how to serialize a BigInt"。
  // 统一转为 string 输出。
  (BigInt.prototype as unknown as { toJSON(): string }).toJSON = function () {
    return this.toString();
  };
}
