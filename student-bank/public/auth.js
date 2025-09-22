const Auth = {
    key: "classbank.accountId",
    save(id) { localStorage.setItem(this.key, id); },
    get() { return localStorage.getItem(this.key); },
    clear() { localStorage.removeItem(this.key); }
  };
  