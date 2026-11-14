// Match the tiny node:sqlite surface used by StoreCore, without a database package.
export function database(storage) {
  return {
    exec(sql) {
      for (const statement of sql.split(';').filter(s => s.trim())) storage.sql.exec(statement);
    },
    prepare(sql) {
      return {
        get: (...args) => storage.sql.exec(sql, ...args).toArray()[0],
        all: (...args) => storage.sql.exec(sql, ...args).toArray(),
        run: (...args) => ({ changes: storage.sql.exec(sql, ...args).rowsWritten }),
      };
    },
    transactionSync: fn => storage.transactionSync(fn),
    close() {},
  };
}
