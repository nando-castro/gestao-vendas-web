import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { BarChart3, Boxes, ChevronDown, CirclePlus, DollarSign, Edit3, Eye, EyeOff, Home as HomeIcon, ImagePlus, Menu, Moon, PackagePlus, PowerOff, RefreshCw, Send, ShoppingCart, Sun, Trash2, UserRound, X } from "lucide-react";
import { api, API_URL, AppUser, Customer, FinanceEntry, ImageSearchResult, Order, PaymentMethod, Product, ProductCategory, ProductLot, StockMovement, SystemLog } from "./lib/api";
import { connectRealtime, debounceRealtime } from "./lib/realtime";
import "./styles/global.css";

document.documentElement.dataset.theme = localStorage.getItem("pedidos-theme") === "dark" ? "dark" : "light";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

const brl = (value: number | string) => Number(value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const dateLabel = (value?: string) => value ? new Date(`${value.includes("T") ? value : `${value}T00:00:00`}`).toLocaleString("pt-BR") : "-";
const assetUrl = (value?: string | null) => value?.startsWith("/uploads/") ? `${API_URL}${value}` : value ?? "";

function formatMoneyInput(value: number | string) {
  const number = typeof value === "number" ? value : Number(value || 0);
  return number.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function parseMoneyInput(value: FormDataEntryValue | string | number | null) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return Number((Number(digits) / 100).toFixed(2));
}

function maskMoneyInput(input: HTMLInputElement) {
  input.value = formatMoneyInput(parseMoneyInput(input.value));
}

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function textMatches(value: string | undefined, query: string) {
  return normalizeText(value ?? "").includes(normalizeText(query));
}

function uppercaseInput(value: string) {
  return value.toLocaleUpperCase("pt-BR");
}

function currentStockPurchaseTotal(product: Product) {
  const activeLots = product.lots?.filter((lot) => lot.currentStock > 0) ?? [];
  if (activeLots.length === 0) return Number(product.costPrice) * product.stock;
  return activeLots.reduce((sum, lot) => {
    const lotCost = lot.totalCost ?? Number(lot.costPrice) * lot.initialStock;
    return sum + Number(lotCost);
  }, 0);
}

function stockRevenue(product: Product) {
  return Number(product.salePrice) * product.stock;
}

function projectedStockProfit(product: Product) {
  return stockRevenue(product) - currentStockPurchaseTotal(product);
}

function saleTotalFromLots(product: Product, quantity: number) {
  let remaining = Math.max(0, quantity);
  let total = 0;
  const lots = (product.lots ?? [])
    .filter((lot) => lot.currentStock > 0)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const lot of lots) {
    if (remaining <= 0) break;
    const lotQuantity = Math.min(remaining, lot.currentStock);
    total += lotQuantity * Number(lot.salePrice);
    remaining -= lotQuantity;
  }
  if (remaining > 0) total += remaining * Number(product.salePrice);
  return total;
}

function nextSalePrice(product: Product) {
  return saleTotalFromLots(product, 1);
}

function skuPreviewPart(value: string, fallback: string) {
  const letters = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  return (letters || fallback).slice(0, 3).padEnd(3, fallback.slice(0, 1));
}

function phoneMask(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

type ProductStats = {
  soldQty: number;
  soldRevenue: number;
  soldCost: number;
  soldProfit: number;
  stockCost: number;
  stockPotential: number;
  totalPotentialRevenue: number;
};

function productStats(product: Product, orders: Order[]): ProductStats {
  const soldItems = orders.flatMap((order) => order.items).filter((item) => item.product?.id === product.id || item.productId === product.id);
  const soldQty = soldItems.reduce((sum, item) => sum + item.quantity, 0);
  const soldRevenue = soldItems.reduce((sum, item) => sum + Number(item.unitPrice) * item.quantity, 0);
  const soldCost = soldItems.reduce((sum, item) => sum + Number(item.costPrice ?? product.costPrice) * item.quantity, 0);
  const stockCost = Number(product.costPrice) * product.stock;
  const stockPotential = Number(product.salePrice) * product.stock;

  return {
    soldQty,
    soldRevenue,
    soldCost,
    soldProfit: soldRevenue - soldCost,
    stockCost,
    stockPotential,
    totalPotentialRevenue: soldRevenue + stockPotential
  };
}

function App() {
  if (window.location.pathname === "/pedido") return <CustomerOrderPage />;

  const [view, setView] = useState("home");
  const [theme, setTheme] = useState<"light" | "dark">(() => localStorage.getItem("pedidos-theme") === "dark" ? "dark" : "light");
  const [menuOpen, setMenuOpen] = useState(false);
  const [openMenuGroups, setOpenMenuGroups] = useState<Record<string, boolean>>({
    main: true,
    catalog: true,
    sales: true,
    admin: true
  });
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [finance, setFinance] = useState<FinanceEntry[]>([]);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);
  const [availablePermissions, setAvailablePermissions] = useState<string[]>([]);
  const [authChecked, setAuthChecked] = useState(false);
  const [lastClientPendingCount, setLastClientPendingCount] = useState(0);
  const [loadedViews, setLoadedViews] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [notification, setNotification] = useState<{ type: "success" | "error"; text: string } | null>(null);

  function notify(type: "success" | "error", text: string) {
    setNotification({ type, text });
    window.setTimeout(() => setNotification(null), 3200);
  }

  const can = (permission: string) => currentUser?.role === "admin" || Boolean(currentUser?.permissions.includes(permission));

  async function checkSession() {
    try {
      const result = await api.me();
      setCurrentUser(result.user);
      setAvailablePermissions(result.permissions);
    } catch {
      api.token.clear();
      setCurrentUser(null);
    } finally {
      setAuthChecked(true);
    }
  }

  async function login(username: string, password: string) {
    const result = await api.login({ username, password });
    setCurrentUser(result.user);
    setAvailablePermissions(result.permissions);
    setAuthChecked(true);
  }

  function logout() {
    api.token.clear();
    setCurrentUser(null);
    setView("home");
  }

  function viewLoaders(targetView: string) {
    const loaders: Array<Promise<unknown>> = [];
    const addProducts = () => loaders.push(api.products().then(setProducts));
    const addCategories = () => loaders.push(api.categories().then(setCategories));
    const addFinance = () => loaders.push(api.finance().then(setFinance));
    const addStock = () => loaders.push(api.stockMovements().then(setStockMovements));
    const addOrders = () => loaders.push(api.orders().then(setOrders));
    const addCustomers = () => loaders.push(api.customers().then(setCustomers));

    if (targetView === "home") {
      addProducts();
      addOrders();
      addCustomers();
      return loaders;
    }
    if (targetView === "dashboard") {
      addProducts();
      addOrders();
      addFinance();
      return loaders;
    }
    if (targetView === "products") {
      addProducts();
      addCategories();
      addOrders();
      return loaders;
    }
    if (targetView === "categories") {
      addCategories();
      addProducts();
      return loaders;
    }
    if (targetView === "stock") {
      addProducts();
      addCategories();
      addStock();
      return loaders;
    }
    if (targetView === "lots") {
      addProducts();
      return loaders;
    }
    if (targetView === "finance") {
      addFinance();
      addProducts();
      addOrders();
      return loaders;
    }
    if (targetView === "orders") {
      addProducts();
      addOrders();
      addCustomers();
      return loaders;
    }
    if (targetView === "clientPageAdmin") {
      addProducts();
      return loaders;
    }
    if (targetView === "customerOrders") {
      addOrders();
      return loaders;
    }
    if (targetView === "customers") {
      addCustomers();
      addOrders();
      return loaders;
    }
    return loaders;
  }

  async function loadView(targetView = view, force = false) {
    if (!force && loadedViews[targetView]) return;
    const loaders = viewLoaders(targetView);
    if (loaders.length === 0) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      await Promise.all(loaders);
      setLoadedViews((current) => ({ ...current, [targetView]: true }));
      setMessage("");
    } catch {
      setMessage("Nao foi possivel carregar os dados. Confira se a API esta ligada.");
    } finally {
      setLoading(false);
    }
  }

  const refreshCurrentView = () => loadView(view, true);

  useEffect(() => { checkSession(); }, []);
  useEffect(() => { if (currentUser) loadView(view); }, [currentUser?.id, view]);
  useEffect(() => {
    if (!currentUser) return;
    const refresh = debounceRealtime(refreshCurrentView);
    return connectRealtime({
      onInventoryUpdated: refresh,
      onOrderChanged: refresh
    });
  }, [currentUser?.id, view]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pedidos-theme", theme);
  }, [theme]);

  const totals = useMemo(() => {
    const stockValue = products.reduce((sum, item) => sum + Number(item.costPrice) * item.stock, 0);
    const expectedRevenue = products.reduce((sum, item) => sum + Number(item.salePrice) * item.stock, 0);
    const soldRevenue = orders.reduce((sum, order) => sum + Number(order.total), 0);
    const soldQty = orders.reduce((sum, order) => sum + order.items.reduce((itemSum, item) => itemSum + item.quantity, 0), 0);
    const soldCost = orders.reduce((sum, order) => sum + order.items.reduce((itemSum, item) => itemSum + Number(item.costPrice ?? item.product?.costPrice ?? 0) * item.quantity, 0), 0);
    const totalProfit = soldRevenue - soldCost;
    const revenue = orders.reduce((sum, order) => sum + Number(order.amountPaid ?? 0), 0);
    const receivable = orders.reduce((sum, order) => sum + Number(order.amountDue ?? 0), 0);
    const expenses = finance.filter((item) => item.type === "expense").reduce((sum, item) => sum + Number(item.amount), 0);
    const lowStock = products.filter((item) => item.stock <= item.minStock).length;
    return { stockValue, expectedRevenue, soldRevenue, soldQty, soldCost, totalProfit, revenue, receivable, expenses, lowStock };
  }, [products, finance, orders]);
  const clientPendingCount = orders.filter((order) => order.source === "client_page" && order.status === "pending").length;

  useEffect(() => {
    if (lastClientPendingCount > 0 && clientPendingCount > lastClientPendingCount) notify("success", "Novo pedido de cliente recebido.");
    setLastClientPendingCount(clientPendingCount);
  }, [clientPendingCount]);

  if (!authChecked) return <main className="login-page"><div className="card login-card"><h1>Pedidos Pro</h1><p className="muted">Carregando acesso...</p></div></main>;
  if (!currentUser) return <LoginPage onLogin={login} />;

  const menuGroups = [
    {
      id: "main",
      label: "Principal",
      items: [
        { view: "home", label: "Inicio", title: "Inicio", icon: HomeIcon, visible: true },
        { view: "dashboard", label: "Dashboard", title: "Dashboard", icon: BarChart3, visible: can("dashboard.view") }
      ]
    },
    {
      id: "catalog",
      label: "Produtos",
      items: [
        { view: "products", label: "Produtos", title: "Produtos", icon: Boxes, visible: can("products.view") },
        { view: "categories", label: "Categorias", title: "Categorias", icon: PackagePlus, visible: can("categories.view") },
        { view: "stock", label: "Estoque", title: "Estoque", icon: PackagePlus, visible: can("stock.view") },
        { view: "lots", label: "Lotes", title: "Lotes", icon: Boxes, visible: can("stock.view") }
      ]
    },
    {
      id: "sales",
      label: "Vendas",
      items: [
        { view: "orders", label: "Vendas", title: "Vendas", icon: ShoppingCart, visible: can("orders.view") },
        { view: "clientPage", label: "Pagina online", title: "Pagina online", icon: Send, visible: can("clientPage.view") },
        { view: "clientPageAdmin", label: "Pedido online", title: "Administrar pagina do cliente", icon: PackagePlus, visible: can("clientPage.manage") },
        { view: "customerOrders", label: "Pedidos clientes", title: "Pedidos clientes", icon: ShoppingCart, visible: can("customerOrders.manage"), count: clientPendingCount },
        { view: "customers", label: "Clientes", title: "Clientes", icon: UserRound, visible: can("customers.view") }
      ]
    },
    {
      id: "admin",
      label: "Administracao",
      items: [
        { view: "finance", label: "Financeiro", title: "Financeiro", icon: DollarSign, visible: can("finance.view") },
        { view: "users", label: "Acessos", title: "Acessos", icon: Eye, visible: can("users.manage") },
        { view: "logs", label: "Logs", title: "Logs", icon: BarChart3, visible: can("logs.view") }
      ]
    }
  ].map((group) => ({ ...group, items: group.items.filter((item) => item.visible) })).filter((group) => group.items.length > 0);

  function toggleMenuGroup(groupId: string) {
    setOpenMenuGroups((current) => ({ ...current, [groupId]: !current[groupId] }));
  }

  const pageTitles: Record<string, string> = {
    home: "Inicio",
    dashboard: "Dashboard",
    products: "Produtos",
    categories: "Categorias",
    stock: "Estoque",
    lots: "Lotes",
    finance: "Financeiro",
    orders: "Registrar venda",
    clientPage: "Pagina online",
    clientPageAdmin: "Pedido online",
    customerOrders: "Pedidos clientes",
    customers: "Clientes",
    users: "Acessos",
    logs: "Logs",
    profile: "Meu perfil"
  };

  return (
    <div className="app">
      <button className="mobile-menu-button" type="button" onClick={() => setMenuOpen(true)}><Menu size={20} />Menu</button>
      {menuOpen && <button className="mobile-menu-backdrop" aria-label="Fechar menu" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <div className="brand-row"><div className="brand">Pedidos Pro</div><button className="icon-btn sidebar-close" type="button" onClick={() => setMenuOpen(false)}><X size={16} /></button></div>
          <button className={view === "profile" ? "profile-button active" : "profile-button"} type="button" onClick={() => { setView("profile"); setMenuOpen(false); }}>
            <span className="profile-avatar">{currentUser.name.slice(0, 1).toUpperCase()}</span>
            <span><strong>{currentUser.name}</strong><small>{currentUser.role}</small></span>
          </button>
          <button className="sidebar-theme-toggle" type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            <span>{theme === "dark" ? "Modo claro" : "Modo escuro"}</span>
          </button>
        </div>
        <nav className="nav">
          {menuGroups.map((group) => {
            const groupHasActiveItem = group.items.some((item) => item.view === view);
            const groupOpen = openMenuGroups[group.id] ?? groupHasActiveItem;
            return <div className="nav-group" key={group.id}>
              <button className={`nav-group-button ${groupHasActiveItem ? "active" : ""}`} type="button" onClick={() => toggleMenuGroup(group.id)}>
                <span>{group.label}</span>
                <ChevronDown className={groupOpen ? "nav-chevron nav-chevron-open" : "nav-chevron"} size={16} />
              </button>
              {groupOpen && <div className="nav-submenu">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return <button className={view === item.view ? "active" : ""} key={item.view} onClick={() => { setView(item.view); setMenuOpen(false); }} title={item.title}>
                    <Icon size={18} />
                    <span>{item.label}</span>
                    {"count" in item && Number(item.count) > 0 && <strong className="nav-count">{item.count}</strong>}
                  </button>;
                })}
              </div>}
            </div>;
          })}
        </nav>
        <button className="logout-button" onClick={logout}>Sair</button>
      </aside>
      <main className="main">
        {view !== "clientPage" && view !== "products" && <div className="topbar page-header-card">
          <div>
            <h1>{pageTitles[view] ?? "Gerenciamento operacional"}</h1>
            <div className="muted">{loading ? "Carregando dados..." : "Produtos, estoque, financeiro e vendas no mesmo lugar"}</div>
          </div>
          {view === "dashboard" && <button className="secondary" onClick={refreshCurrentView}><RefreshCw size={16} />Atualizar</button>}
        </div>}

        {notification && <div className={`notification notification-${notification.type}`}>{notification.text}</div>}
        {message && <div className="alert">{message}</div>}
        {view === "home" && <Home user={currentUser} totals={totals} products={products} orders={orders} customers={customers} setView={setView} can={can} />}
        {view === "dashboard" && <Dashboard totals={totals} products={products} orders={orders} />}
        {view === "products" && <Products products={products} categories={categories} orders={orders} onSaved={refreshCurrentView} notify={notify} can={can} isAdmin={currentUser.role === "admin"} />}
        {view === "categories" && <Categories categories={categories} products={products} onSaved={refreshCurrentView} notify={notify} can={can} />}
        {view === "stock" && <Stock products={products} movements={stockMovements} categories={categories} onSaved={refreshCurrentView} notify={notify} can={can} />}
        {view === "lots" && <LotsPage products={products} onSaved={refreshCurrentView} notify={notify} can={can} />}
        {view === "finance" && <Finance entries={finance} products={products} orders={orders} onSaved={refreshCurrentView} notify={notify} can={can} />}
        {view === "orders" && <Orders products={products} orders={orders} customers={customers} onSaved={refreshCurrentView} notify={notify} can={can} />}
        {view === "clientPage" && <CustomerOrderPage embedded />}
        {view === "clientPageAdmin" && <ClientPageAdmin products={products} onSaved={refreshCurrentView} notify={notify} />}
        {view === "customerOrders" && <CustomerOrdersPage orders={orders} onSaved={refreshCurrentView} notify={notify} />}
        {view === "customers" && <Customers customers={customers} orders={orders} onSaved={refreshCurrentView} notify={notify} can={can} isAdmin={currentUser.role === "admin"} />}
        {view === "users" && <UsersManager availablePermissions={availablePermissions} onSaved={refreshCurrentView} notify={notify} />}
        {view === "logs" && <LogsPage notify={notify} />}
        {view === "profile" && <ProfilePage user={currentUser} theme={theme} onThemeChange={setTheme} />}
      </main>
    </div>
  );
}

function LoginPage({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoading(true);
    setError("");
    try {
      await onLogin(String(form.get("username")), String(form.get("password")));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nao foi possivel entrar.");
    } finally {
      setLoading(false);
    }
  }

  return <main className="login-page">
    <form className="card login-card" onSubmit={submit}>
      <h1>Pedidos Pro</h1>
      <p className="muted">Entre para acessar o sistema.</p>
      {error && <div className="alert">{error}</div>}
      <label>Usuario<input name="username" autoFocus required /></label>
      <label>Senha
        <span className="password-field">
          <input name="password" type={showPassword ? "text" : "password"} required />
          <button type="button" title={showPassword ? "Ocultar senha" : "Mostrar senha"} aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"} onClick={() => setShowPassword((current) => !current)}>
            {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
        </span>
      </label>
      <button className="primary" disabled={loading} type="submit">{loading ? "Entrando..." : "Entrar"}</button>
      <p className="muted">Primeiro acesso: usuario admin e senha admin123.</p>
    </form>
  </main>;
}

function ProfilePage({ user, theme, onThemeChange }: { user: AppUser; theme: "light" | "dark"; onThemeChange: (theme: "light" | "dark") => void }) {
  return <section className="profile-page">
    <div className="card profile-card">
      <div className="profile-avatar profile-avatar-large">{user.name.slice(0, 1).toUpperCase()}</div>
      <div>
        <h2>{user.name}</h2>
        <p className="muted">{user.username}</p>
      </div>
      <div className="profile-info-grid">
        <div><span className="muted">Perfil</span><strong>{user.role}</strong></div>
        <div><span className="muted">Status</span><strong>{user.active ? "Ativo" : "Inativo"}</strong></div>
        <div><span className="muted">Permissoes</span><strong>{user.role === "admin" ? "Todas" : user.permissions.length}</strong></div>
      </div>
      <div className="profile-settings">
        <div>
          <span className="muted">Aparencia</span>
          <strong>{theme === "dark" ? "Modo escuro" : "Modo claro"}</strong>
        </div>
        <button className="theme-toggle-button" type="button" onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          {theme === "dark" ? "Usar modo claro" : "Usar modo escuro"}
        </button>
      </div>
    </div>
  </section>;
}

const permissionLabels: Record<string, string> = {
  "home.view": "Ver inicio",
  "dashboard.view": "Ver dashboard",
  "products.view": "Ver produtos",
  "products.create": "Cadastrar produtos",
  "products.edit": "Editar produtos",
  "categories.view": "Ver categorias",
  "categories.create": "Cadastrar categorias",
  "categories.edit": "Editar categorias",
  "stock.view": "Ver estoque",
  "stock.move": "Movimentar estoque",
  "finance.view": "Ver financeiro",
  "finance.create": "Criar lancamentos financeiros",
  "orders.view": "Ver vendas",
  "orders.create": "Cadastrar vendas",
  "orders.edit": "Editar vendas",
  "orders.delete": "Remover vendas",
  "orders.receive": "Registrar recebimentos",
  "customerOrders.manage": "Gerenciar pedidos de clientes",
  "clientPage.view": "Ver pagina online",
  "clientPage.manage": "Administrar pagina do cliente",
  "customers.view": "Ver clientes",
  "customers.create": "Cadastrar clientes",
  "customers.edit": "Editar clientes",
  "users.manage": "Gerenciar acessos",
  "logs.view": "Ver logs"
};

function LogsPage({ notify }: { notify: Notify }) {
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadLogs() {
    try {
      setLoading(true);
      setLogs(await api.logs());
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel carregar os logs.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadLogs(); }, []);

  return <section className="stack">
    <div className="card table-wrap">
      <div className="section-heading">
        <h2>Logs do sistema</h2>
        <button className="secondary" type="button" onClick={loadLogs}><RefreshCw size={16} />Atualizar logs</button>
      </div>
      <table>
        <thead><tr><th>Data</th><th>Tipo</th><th>Usuario</th><th>Perfil</th><th>Acao</th><th>Rota</th><th>Mensagem</th></tr></thead>
        <tbody>
          {loading && <tr><td colSpan={7}>Carregando logs...</td></tr>}
          {!loading && logs.length === 0 && <tr><td colSpan={7}>Nenhum log registrado.</td></tr>}
          {logs.map((log) => <tr key={log.id}>
            <td>{new Date(log.createdAt).toLocaleString("pt-BR")}</td>
            <td><span className={`badge ${log.type === "error" ? "badge-error" : ""}`}>{log.type === "login" ? "Login" : "Erro"}</span></td>
            <td>{log.username || "-"}</td>
            <td>{log.role || "-"}</td>
            <td>{log.action}</td>
            <td>{log.method ? `${log.method} ${log.route ?? ""}` : log.route ?? "-"}</td>
            <td>{log.message}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>;
}

function CustomerOrdersPage({ orders, onSaved, notify }: { orders: Order[]; onSaved: () => void; notify: Notify }) {
  const clientOrders = orders.filter((order) => order.source === "client_page");
  const [filter, setFilter] = useState<"pending" | "preparing" | "ready" | "delivered" | "cancelled">("pending");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [viewingOrder, setViewingOrder] = useState<Order | null>(null);
  const [statusChange, setStatusChange] = useState<{ order: Order; status: "pending" | "preparing" | "ready" | "delivered" | "cancelled" } | null>(null);
  const [cancelKey, setCancelKey] = useState("");
  const [savingStatus, setSavingStatus] = useState(false);

  async function setStatus(order: Order, status: "pending" | "preparing" | "ready" | "delivered" | "cancelled", removalKey?: string) {
    if (savingStatus) return;
    setSavingStatus(true);
    try {
      await api.updateOrderStatus(order.id, status, removalKey);
      await onSaved();
      setStatusChange(null);
      setCancelKey("");
      notify("success", "Status do pedido atualizado.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel atualizar o pedido.");
    } finally {
      setSavingStatus(false);
    }
  }

  const statusLabel: Record<string, string> = {
    pending: "Novo",
    preparing: "Preparando",
    ready: "Pronto para entrega",
    delivered: "Entregue",
    cancelled: "Cancelado"
  };
  const visibleOrders = clientOrders.filter((order) => order.status === filter);
  const filterTitle: Record<typeof filter, string> = {
    pending: "Novos pedidos",
    preparing: "Pedidos em preparo",
    ready: "Pedidos prontos",
    delivered: "Pedidos entregues",
    cancelled: "Pedidos cancelados"
  };

  function orderActions(order: Order) {
    if (order.status === "pending") {
      return <>
        <button className="status-button status-confirm" onClick={() => setStatusChange({ order, status: "preparing" })}>Confirmar preparo</button>
        <button className="status-button status-cancel" onClick={() => setStatusChange({ order, status: "cancelled" })}>Cancelar</button>
      </>;
    }
    if (order.status === "preparing") {
      return <>
        <button className="status-button status-back" onClick={() => setStatusChange({ order, status: "pending" })}>Voltar</button>
        <button className="status-button status-ready" onClick={() => setStatusChange({ order, status: "ready" })}>Marcar pronto</button>
        <button className="status-button status-cancel" onClick={() => setStatusChange({ order, status: "cancelled" })}>Cancelar</button>
      </>;
    }
    if (order.status === "ready") {
      return <>
        <button className="status-button status-back" onClick={() => setStatusChange({ order, status: "preparing" })}>Voltar</button>
        <button className="status-button status-delivered" onClick={() => setStatusChange({ order, status: "delivered" })}>Entregar</button>
        <button className="status-button status-cancel" onClick={() => setStatusChange({ order, status: "cancelled" })}>Cancelar</button>
      </>;
    }
    if (order.status === "cancelled") {
      return null;
    }
    return <>
      <button className="status-button status-back" onClick={() => setStatusChange({ order, status: "ready" })}>Voltar</button>
      <span className="muted">Finalizado</span>
    </>;
  }

  return <section className="stack">
    <div className="metrics order-filter-cards">
      <button className={`metric metric-orange ${filter === "pending" ? "metric-active" : ""}`} onClick={() => setFilter("pending")}>Novos pedidos<strong>{clientOrders.filter((order) => order.status === "pending").length}</strong></button>
      <button className={`metric metric-blue ${filter === "preparing" ? "metric-active" : ""}`} onClick={() => setFilter("preparing")}>Preparando<strong>{clientOrders.filter((order) => order.status === "preparing").length}</strong></button>
      <button className={`metric metric-green ${filter === "ready" ? "metric-active" : ""}`} onClick={() => setFilter("ready")}>Prontos<strong>{clientOrders.filter((order) => order.status === "ready").length}</strong></button>
      <button className={`metric metric-slate ${filter === "delivered" ? "metric-active" : ""}`} onClick={() => setFilter("delivered")}>Entregues<strong>{clientOrders.filter((order) => order.status === "delivered").length}</strong></button>
      <button className={`metric metric-red ${filter === "cancelled" ? "metric-active" : ""}`} onClick={() => setFilter("cancelled")}>Cancelados<strong>{clientOrders.filter((order) => order.status === "cancelled").length}</strong></button>
    </div>
    <div className="card table-wrap">
      <h2>{filterTitle[filter]}</h2>
      <table>
        <thead><tr><th></th><th>Data</th><th>Cliente</th><th className="mobile-hide">Telefone</th><th className="mobile-hide">Total</th><th className="mobile-hide">Status</th><th>Acoes</th></tr></thead>
        <tbody>
          {visibleOrders.length === 0 && <tr><td colSpan={7}>Nenhum pedido nesta etapa.</td></tr>}
          {visibleOrders.map((order) => <React.Fragment key={order.id}>
            <tr>
              <td className="expand-cell">
                <button
                  className={`circle-action ${expanded[order.id] ? "circle-action-active" : ""}`}
                  title={expanded[order.id] ? "Recolher itens" : "Expandir itens"}
                  onClick={() => setExpanded((current) => ({ ...current, [order.id]: !current[order.id] }))}
                >
                  <CirclePlus size={18} />
                </button>
              </td>
              <td>{new Date(order.createdAt).toLocaleString("pt-BR")}</td>
              <td>{order.customerName}</td>
              <td className="mobile-hide">{order.customerPhone || "-"}</td>
              <td className="mobile-hide">{brl(order.total)}</td>
              <td className="mobile-hide"><span className="badge">{statusLabel[order.status] ?? order.status}</span></td>
              <td><div className="action-row">
                <button className="icon-btn action-icon action-view" title="Visualizar pedido" aria-label={`Visualizar pedido de ${order.customerName}`} onClick={() => setViewingOrder(order)}><Eye size={16} /></button>
                {orderActions(order)}
              </div></td>
            </tr>
            {expanded[order.id] && <tr className="expanded-row">
              <td colSpan={7}>
                <div className="order-items-list">
                  {order.items.map((item) => <div key={item.productId + item.quantity}>
                    <span>{item.quantity}x {item.product?.name ?? "Produto"}</span>
                    <strong>{brl(Number(item.unitPrice) * item.quantity)}</strong>
                  </div>)}
                </div>
              </td>
            </tr>}
          </React.Fragment>)}
        </tbody>
      </table>
    </div>
    {viewingOrder && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <div className="modal-title-row">
          <div>
            <span className="badge">Itens do pedido</span>
            <h2>{viewingOrder.customerName}</h2>
          </div>
          <button className="icon-btn" onClick={() => setViewingOrder(null)}><X size={18} /></button>
        </div>
        <div className="order-modal-summary">
          <div className="order-summary-row"><span>Data</span><strong>{new Date(viewingOrder.createdAt).toLocaleString("pt-BR")}</strong></div>
          <div className="order-summary-row"><span>Telefone</span><strong>{viewingOrder.customerPhone || "-"}</strong></div>
          <div className="order-summary-row"><span>Total</span><strong>{brl(viewingOrder.total)}</strong></div>
          <div className="order-summary-row"><span>Status</span><strong>{statusLabel[viewingOrder.status] ?? viewingOrder.status}</strong></div>
          {viewingOrder.status === "cancelled" && <div className="order-summary-row"><span>Cancelado por</span><strong>{viewingOrder.cancelledByName ?? "-"}</strong></div>}
          {viewingOrder.status === "cancelled" && <div className="order-summary-row"><span>Cancelado em</span><strong>{viewingOrder.cancelledAt ? new Date(viewingOrder.cancelledAt).toLocaleString("pt-BR") : "-"}</strong></div>}
        </div>
        <div className="order-items-modal">
          {viewingOrder.items.map((item) => <div className="order-item-card" key={item.productId + item.quantity}>
            <div className="order-item-image">
              {item.product?.imageUrl ? <img src={assetUrl(item.product.imageUrl)} alt={item.product.name} /> : <Boxes size={24} />}
            </div>
            <div>
              <strong>{item.product?.name ?? "Produto"}</strong>
              <span>{item.quantity} unidade(s) x {brl(item.unitPrice)}</span>
            </div>
            <strong>{brl(Number(item.unitPrice) * item.quantity)}</strong>
          </div>)}
        </div>
      </div>
    </div>}
    {statusChange && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal confirm-modal">
        <div className="modal-title-row">
          <div>
            <span className="badge">Confirmar acao</span>
            <h2>Alterar status do pedido?</h2>
          </div>
          <button className="icon-btn" onClick={() => setStatusChange(null)}><X size={18} /></button>
        </div>
        <p className="muted">
          O pedido de <strong>{statusChange.order.customerName}</strong> vai sair de <strong>{statusLabel[statusChange.order.status] ?? statusChange.order.status}</strong> para <strong>{statusLabel[statusChange.status] ?? statusChange.status}</strong>.
        </p>
        {statusChange.status === "cancelled" && <label>Chave de seguranca<input type="password" value={cancelKey} onChange={(event) => setCancelKey(event.target.value)} placeholder="Informe a chave para cancelar" /></label>}
        <div className="confirm-actions">
          <button className="secondary" onClick={() => { setStatusChange(null); setCancelKey(""); }}>Fechar</button>
          <button className={statusChange.status === "cancelled" ? "primary danger-primary confirm-danger-button" : "primary"} disabled={savingStatus || (statusChange.status === "cancelled" && cancelKey.trim().length === 0)} onClick={() => setStatus(statusChange.order, statusChange.status, cancelKey)}>{savingStatus ? "Salvando..." : statusChange.status === "cancelled" ? "Cancelar pedido" : "Confirmar"}</button>
        </div>
      </div>
    </div>}
  </section>;
}

function UsersManager({ availablePermissions, onSaved, notify }: { availablePermissions: string[]; onSaved: () => void; notify: Notify }) {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [editing, setEditing] = useState<AppUser | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  async function loadUsers() {
    setUsers(await api.users());
  }

  useEffect(() => { loadUsers().catch(() => notify("error", "Nao foi possivel carregar usuarios.")); }, []);

  function openNew() {
    setEditing(null);
    setSelectedPermissions(["home.view"]);
    setModalOpen(true);
  }

  function openEdit(user: AppUser) {
    setEditing(user);
    setSelectedPermissions(user.permissions);
    setModalOpen(true);
  }

  function togglePermission(permission: string) {
    setSelectedPermissions((current) => current.includes(permission) ? current.filter((item) => item !== permission) : [...current, permission]);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const data = Object.fromEntries(new FormData(event.currentTarget));
    const payload = {
      name: uppercaseInput(String(data.name)),
      username: String(data.username),
      password: String(data.password || ""),
      role: String(data.role) as "usuario" | "cliente",
      active: data.active === "on",
      permissions: selectedPermissions
    };
    if (!payload.password) delete (payload as Partial<typeof payload>).password;
    setSaving(true);
    try {
      if (editing) await api.updateUser(editing.id, payload);
      else await api.createUser(payload);
      setModalOpen(false);
      setEditing(null);
      await loadUsers();
      await onSaved();
      notify("success", editing ? "Usuario atualizado com sucesso." : "Usuario criado com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel salvar o usuario.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="stack">
    {modalOpen && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <div className="card-title-row">
          <h2>{editing ? "Editar usuario" : "Novo usuario"}</h2>
          <button className="icon-btn" type="button" onClick={() => setModalOpen(false)}><X size={16} /></button>
        </div>
        <form className="form two" onSubmit={submit}>
          <label>Nome<input name="name" defaultValue={editing?.name ?? ""} onChange={(event) => { event.currentTarget.value = uppercaseInput(event.currentTarget.value); }} required /></label>
          <label>Usuario<input name="username" defaultValue={editing?.username ?? ""} required /></label>
          <label>Senha<input name="password" type="password" placeholder={editing ? "Deixe em branco para manter" : "Senha inicial"} required={!editing} /></label>
          <label>Perfil<select name="role" defaultValue={editing?.role === "cliente" ? "cliente" : "usuario"} disabled={editing?.role === "admin"}>
            <option value="usuario">Usuario</option>
            <option value="cliente">Cliente</option>
          </select></label>
          <label className="check-row"><input name="active" type="checkbox" defaultChecked={editing?.active ?? true} />Usuario ativo</label>
          <div className="permissions-box full-row">
            {availablePermissions.filter((permission) => permission !== "users.manage").map((permission) => <label className="check-row" key={permission}>
              <input type="checkbox" checked={selectedPermissions.includes(permission)} onChange={() => togglePermission(permission)} />
              {permissionLabels[permission] ?? permission}
            </label>)}
          </div>
          <button className="primary" type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar acesso"}</button>
        </form>
      </div>
    </div>}
    <div className="card table-wrap">
      <div className="section-heading">
        <h2>Gerenciamento de acessos</h2>
        <button className="primary" type="button" onClick={openNew}><UserRound size={18} />Novo usuario</button>
      </div>
      <table>
        <thead><tr><th>Nome</th><th>Usuario</th><th>Perfil</th><th>Status</th><th>Permissoes</th><th>Acoes</th></tr></thead>
        <tbody>
          {users.map((user) => <tr key={user.id}>
            <td>{user.name}</td>
            <td>{user.username}</td>
            <td>{user.role}</td>
            <td><span className="badge">{user.active ? "Ativo" : "Inativo"}</span></td>
            <td>{user.role === "admin" ? "Todas" : user.permissions.length}</td>
            <td>{user.role === "admin" ? <span className="muted">ADMIN livre</span> : <button className="icon-btn action-icon action-edit" title="Editar acesso" aria-label={`Editar acesso de ${user.name}`} onClick={() => openEdit(user)}><Edit3 size={16} /></button>}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>;
}

function CustomerOrderPage({ embedded = false }: { embedded?: boolean }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [draftCart, setDraftCart] = useState<Record<string, number>>({});
  const [cartOpen, setCartOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [message, setMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  async function loadOnlineProducts() {
    try {
      const items = await api.products();
      const availableProducts = items.filter((product) => product.active && product.onlineAvailable !== false && product.stock > 0);
      setProducts(availableProducts);
      setCart((current) => {
        const next: Record<string, number> = {};
        for (const product of availableProducts) {
          const quantity = current[product.id] ?? 0;
          if (quantity > 0) next[product.id] = Math.min(quantity, product.stock);
        }
        return next;
      });
      setDraftCart((current) => {
        const next: Record<string, number> = {};
        for (const product of availableProducts) {
          const quantity = current[product.id] ?? 0;
          if (quantity > 0) next[product.id] = Math.min(quantity, product.stock);
        }
        return next;
      });
      setMessage("");
    } catch {
      setMessage("Nao foi possivel carregar os produtos.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadOnlineProducts();
  }, []);

  useEffect(() => {
    const refresh = debounceRealtime(loadOnlineProducts);
    return connectRealtime({
      onInventoryUpdated: refresh,
      onOrderChanged: refresh
    });
  }, []);

  const selectedItems = products
    .filter((product) => (cart[product.id] ?? 0) > 0)
    .map((product) => ({ product, quantity: cart[product.id] ?? 0, subtotal: saleTotalFromLots(product, cart[product.id] ?? 0) }));
  const total = selectedItems.reduce((sum, item) => sum + item.subtotal, 0);

  function setQuantity(product: Product, quantity: number) {
    setDraftCart((current) => ({ ...current, [product.id]: Math.max(0, Math.min(quantity, product.stock)) }));
  }

  function addToCart(product: Product) {
    const quantity = draftCart[product.id] ?? 0;
    if (quantity <= 0) return;
    setCart((current) => ({ ...current, [product.id]: Math.min((current[product.id] ?? 0) + quantity, product.stock) }));
    setDraftCart((current) => ({ ...current, [product.id]: 0 }));
  }

  function removeFromCart(productId: string) {
    setCart((current) => {
      const next = { ...current };
      delete next[productId];
      return next;
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingOrder || total <= 0) return;
    const form = new FormData(event.currentTarget);
    setSubmittingOrder(true);
    try {
      await api.createOrder({
        source: "client_page",
        saleType: "cliente",
        customerName: uppercaseInput(String(form.get("customerName"))),
        customerPhone: String(form.get("customerPhone")),
        paymentMethod: "pix",
        items: selectedItems.map((item) => ({ productId: item.product.id, quantity: item.quantity }))
      });
      setCart({});
      setDraftCart({});
      setCartOpen(false);
      setSuccessMessage("Pedido registrado com sucesso. Em breve ele sera preparado.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Nao foi possivel registrar o pedido.");
    } finally {
      setSubmittingOrder(false);
    }
  }

  const content = <>
    <header className="customer-header">
      <div>
        <span className="badge">Pedido online</span>
        <h1>Escolha seus produtos</h1>
        <p className="muted">{loading ? "Carregando produtos..." : "Monte seu pedido e acompanhe a preparacao."}</p>
      </div>
      <button className="cart-button" type="button" onClick={() => setCartOpen(true)}><ShoppingCart size={18} />Carrinho<span>{selectedItems.length}</span></button>
    </header>
    {message && <div className="alert">{message}</div>}
    {successMessage && <div className="alert success-alert">{successMessage}</div>}
    <section className="customer-layout">
      <div className="catalog customer-catalog">
        {products.map((product, index) => <div className={`card product-card customer-product customer-product-${index % 4}`} key={product.id}>
          <div className="customer-product-hero">
            <ProductImage product={product} />
            <span className="customer-price">{brl(nextSalePrice(product))}</span>
          </div>
          <div className="customer-product-body">
            <strong>{product.name}</strong>
            <span className="muted">Disponivel: {product.stock}</span>
          </div>
          <div className="customer-qty">
            <button type="button" onClick={() => setQuantity(product, (draftCart[product.id] ?? 0) - 1)}>-</button>
            <input type="number" min="0" max={product.stock} value={draftCart[product.id] ?? 0} onChange={(event) => setQuantity(product, Number(event.target.value))} />
            <button type="button" onClick={() => setQuantity(product, (draftCart[product.id] ?? 0) + 1)}>+</button>
          </div>
          <button className="add-cart-button" type="button" disabled={(draftCart[product.id] ?? 0) <= 0} onClick={() => addToCart(product)}>
            <ShoppingCart size={16} />Adicionar ao carrinho
          </button>
        </div>)}
      </div>
      {cartOpen && <div className="modal-backdrop customer-cart-backdrop" role="dialog" aria-modal="true">
      <div className="card checkout customer-checkout modal customer-cart-drawer">
        <div className="card-title-row">
          <div>
            <span className="badge">Resumo</span>
            <h2>Seu pedido</h2>
          </div>
          <button className="icon-btn" type="button" onClick={() => setCartOpen(false)}><X size={16} /></button>
        </div>
        <form className="form" onSubmit={submit}>
          <label>Nome<input name="customerName" required onChange={(event) => { event.currentTarget.value = uppercaseInput(event.currentTarget.value); }} /></label>
          <label>Telefone<input name="customerPhone" required inputMode="tel" placeholder="(11) 99999-9999" onChange={(event) => { event.currentTarget.value = phoneMask(event.currentTarget.value); }} /></label>
          <div className="sale-summary">
            {selectedItems.length === 0 && <span className="muted">Nenhum produto selecionado.</span>}
            {selectedItems.map((item) => <div className="cart-line" key={item.product.id}>
              <span>{item.quantity}x {item.product.name}</span>
              <strong>{brl(item.subtotal)}</strong>
              <button type="button" title="Remover item" onClick={() => removeFromCart(item.product.id)}><Trash2 size={16} /></button>
            </div>)}
          </div>
          <div className="customer-total"><span>Total</span><strong>{brl(total)}</strong></div>
          <button className="primary" disabled={total <= 0 || submittingOrder} type="submit"><Send size={18} />{submittingOrder ? "Registrando..." : "Registrar pedido"}</button>
        </form>
      </div>
      </div>}
    </section>
  </>;

  return embedded ? <section className="customer-page embedded-customer-page">{content}</section> : <main className="customer-page">{content}</main>;
}

function ClientPageAdmin({ products, onSaved, notify }: { products: Product[]; onSaved: () => void; notify: Notify }) {
  const [savingId, setSavingId] = useState("");
  const sortedProducts = products
    .filter((product) => product.active)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  const availableCount = sortedProducts.filter((product) => product.onlineAvailable !== false).length;

  async function toggleOnlineProduct(product: Product) {
    const nextValue = product.onlineAvailable === false;
    setSavingId(product.id);
    try {
      await api.updateProduct(product.id, { onlineAvailable: nextValue });
      await onSaved();
      notify("success", nextValue ? "Produto liberado na pagina do cliente." : "Produto removido da pagina do cliente.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel atualizar a pagina do cliente.");
    } finally {
      setSavingId("");
    }
  }

  return <section className="stack">
    <div className="card table-wrap">
      <div className="section-heading">
        <div>
          <h2>Produtos da pagina do cliente</h2>
          <p className="muted">{availableCount} de {sortedProducts.length} produto(s) disponivel(is) no pedido online.</p>
        </div>
      </div>
      <table>
        <thead><tr><th>Produto</th><th>Categoria</th><th>Marca</th><th>Estoque</th><th>Status online</th><th>Acoes</th></tr></thead>
        <tbody>
          {sortedProducts.length === 0 && <tr><td colSpan={6}>Nenhum produto cadastrado.</td></tr>}
          {sortedProducts.map((product) => {
            const online = product.onlineAvailable !== false;
            return <tr key={product.id}>
              <td><div className="product-cell"><ProductImage product={product} /><span>{product.name}</span></div></td>
              <td>{product.category?.name ?? "-"}</td>
              <td>{product.brand || "-"}</td>
              <td>{product.stock}</td>
              <td><span className={`badge ${online ? "" : "badge-error"}`}>{online ? "Disponivel" : "Oculto"}</span></td>
              <td>
                <button className={`online-toggle-button ${online ? "online-toggle-hide" : "online-toggle-show"}`} type="button" disabled={savingId === product.id} onClick={() => toggleOnlineProduct(product)}>
                  {online ? <Eye size={16} /> : <Send size={16} />}
                  {savingId === product.id ? "Salvando..." : online ? "Ocultar" : "Disponibilizar"}
                </button>
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  </section>;
}

function Dashboard({ totals, products, orders }: { totals: any; products: Product[]; orders: Order[] }) {
  const activeOrders = orders.filter((order) => order.status !== "cancelled");
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 6);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const orderProfit = (order: Order) => order.items.reduce((sum, item) => sum + (Number(item.unitPrice) - Number(item.costPrice ?? item.product?.costPrice ?? 0)) * item.quantity, 0);
  const orderRevenue = (order: Order) => order.items.reduce((sum, item) => sum + Number(item.unitPrice) * item.quantity, 0);
  const ordersFrom = (date: Date) => activeOrders.filter((order) => new Date(order.createdAt) >= date);
  const weekOrders = ordersFrom(startOfWeek);
  const monthOrders = ordersFrom(startOfMonth);
  const weeklyProfit = weekOrders.reduce((sum, order) => sum + orderProfit(order), 0);
  const monthlyProfit = monthOrders.reduce((sum, order) => sum + orderProfit(order), 0);
  const weeklyRevenue = weekOrders.reduce((sum, order) => sum + orderRevenue(order), 0);
  const monthlyRevenue = monthOrders.reduce((sum, order) => sum + orderRevenue(order), 0);
  const stockUnits = products.reduce((sum, product) => sum + product.stock, 0);
  const remainingRevenue = products.reduce((sum, product) => sum + saleTotalFromLots(product, product.stock), 0);
  const remainingCost = currentStockPurchaseTotal ? products.reduce((sum, product) => sum + currentStockPurchaseTotal(product), 0) : 0;
  const remainingProfit = remainingRevenue - remainingCost;
  const avgTicket = activeOrders.length > 0 ? activeOrders.reduce((sum, order) => sum + orderRevenue(order), 0) / activeOrders.length : 0;
  const lowStock = products.filter((product) => product.stock > 0 && product.stock <= product.minStock).length;
  const outOfStock = products.filter((product) => product.stock <= 0).length;
  const dailySales = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(startOfToday);
    date.setDate(startOfToday.getDate() - (6 - index));
    const key = date.toISOString().slice(0, 10);
    const dayOrders = activeOrders.filter((order) => order.createdAt.slice(0, 10) === key);
    const revenue = dayOrders.reduce((sum, order) => sum + orderRevenue(order), 0);
    const profit = dayOrders.reduce((sum, order) => sum + orderProfit(order), 0);
    return { key, label: date.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", ""), revenue, profit, count: dayOrders.length };
  });
  const maxDailyRevenue = Math.max(...dailySales.map((day) => day.revenue), 1);

  return <>
    <section className="metrics">
      <div className="metric metric-blue">Gasto no estoque<strong>{brl(totals.stockValue)}</strong></div>
      <div className="metric metric-orange">Arrecadacao prevista<strong>{brl(totals.expectedRevenue)}</strong></div>
      <div className="metric metric-green">Vendido total<strong>{brl(totals.soldRevenue)}</strong></div>
      <div className="metric metric-purple">Lucro total<strong>{brl(totals.totalProfit)}</strong></div>
    </section>
    <section className="metrics">
      <div className="metric metric-teal">Ja recebido<strong>{brl(totals.revenue)}</strong></div>
      <div className="metric metric-red">A receber<strong>{brl(totals.receivable)}</strong></div>
      <div className="metric metric-slate">Custo vendido<strong>{brl(totals.soldCost)}</strong></div>
      <div className="metric metric-indigo">Itens vendidos<strong>{totals.soldQty}</strong></div>
    </section>
    <section className="metrics">
      <div className="metric metric-green">Estoque restante<strong>{stockUnits}</strong><span className="metric-note">{brl(remainingRevenue)} a arrecadar</span></div>
      <div className="metric metric-purple">Lucro previsto restante<strong>{brl(remainingProfit)}</strong><span className="metric-note">sobre estoque atual</span></div>
      <div className="metric metric-teal">Lucro semanal<strong>{brl(weeklyProfit)}</strong><span className="metric-note">{brl(weeklyRevenue)} vendido</span></div>
      <div className="metric metric-orange">Lucro mensal<strong>{brl(monthlyProfit)}</strong><span className="metric-note">{brl(monthlyRevenue)} vendido</span></div>
    </section>
    <section className="metrics">
      <div className="metric metric-slate">Ticket medio<strong>{brl(avgTicket)}</strong></div>
      <div className="metric metric-red">Estoque baixo<strong>{lowStock}</strong></div>
      <div className="metric metric-red">Sem estoque<strong>{outOfStock}</strong></div>
      <div className="metric metric-blue">Vendas na semana<strong>{weekOrders.length}</strong></div>
    </section>
    <section className="dashboard-grid">
      <div className="card dashboard-chart-card">
        <div className="section-heading">
          <div>
            <h2>Vendas diarias</h2>
            <p className="muted">Receita dos ultimos 7 dias.</p>
          </div>
        </div>
        <div className="daily-sales-chart">
          {dailySales.map((day) => <div className="daily-sales-bar" key={day.key}>
            <strong>{brl(day.revenue)}</strong>
            <div className="bar-track"><span style={{ height: `${Math.max(8, (day.revenue / maxDailyRevenue) * 100)}%` }} /></div>
            <span>{day.label}</span>
            <small>{day.count} venda(s)</small>
          </div>)}
        </div>
      </div>
      <div className="card dashboard-insights">
        <h2>Resumo do periodo</h2>
        <div><span>Receita semanal</span><strong>{brl(weeklyRevenue)}</strong></div>
        <div><span>Receita mensal</span><strong>{brl(monthlyRevenue)}</strong></div>
        <div><span>Margem semanal</span><strong>{weeklyRevenue > 0 ? `${((weeklyProfit / weeklyRevenue) * 100).toFixed(1)}%` : "0%"}</strong></div>
        <div><span>Margem mensal</span><strong>{monthlyRevenue > 0 ? `${((monthlyProfit / monthlyRevenue) * 100).toFixed(1)}%` : "0%"}</strong></div>
      </div>
    </section>
  </>;
}

function Home({ user, totals, products, orders, customers, setView, can }: { user: AppUser; totals: any; products: Product[]; orders: Order[]; customers: Customer[]; setView: (view: string) => void; can: (permission: string) => boolean }) {
  const cards = [
    {
      title: "Dashboard",
      permission: "dashboard.view",
      icon: <BarChart3 size={22} />,
      color: "home-blue",
      text: `${brl(totals.totalProfit)} de lucro`,
      actions: [{ label: "Resumo", view: "dashboard" }]
    },
    {
      title: "Produtos",
      permission: "products.view",
      icon: <Boxes size={22} />,
      color: "home-green",
      text: `${products.length} produtos cadastrados`,
      actions: [{ label: "Cadastrar", view: "products" }, { label: "Listar", view: "products" }]
    },
    {
      title: "Estoque",
      permission: "stock.view",
      icon: <PackagePlus size={22} />,
      color: "home-orange",
      text: `${totals.lowStock} produtos em alerta`,
      actions: [{ label: "Movimentar", view: "stock" }]
    },
    {
      title: "Financeiro",
      permission: "finance.view",
      icon: <DollarSign size={22} />,
      color: "home-purple",
      text: `${brl(totals.receivable)} a receber`,
      actions: [{ label: "Lancamentos", view: "finance" }]
    },
    {
      title: "Vendas",
      permission: "orders.view",
      icon: <ShoppingCart size={22} />,
      color: "home-teal",
      text: `${orders.length} vendas registradas`,
      actions: [{ label: "Cadastrar venda", view: "orders" }, { label: "Fiados", view: "orders" }]
    },
    {
      title: "Clientes",
      permission: "customers.view",
      icon: <UserRound size={22} />,
      color: "home-red",
      text: `${customers.length} clientes cadastrados`,
      actions: [{ label: "Clientes", view: "customers" }]
    }
  ];

  return <section className="home-page">
    <div className="home-welcome">
      <span className="badge">Bem-vindo</span>
      <h2>{user.name}</h2>
      <p className="muted">Escolha uma area para continuar gerenciando produtos, estoque, vendas e clientes.</p>
    </div>
    <div className="home-cards">
      {cards.filter((card) => can(card.permission)).map((card) => <div className={`home-card ${card.color}`} key={card.title}>
        <div className="home-icon">{card.icon}</div>
        <h3>{card.title}</h3>
        <p>{card.text}</p>
        <div className="home-actions">
          {card.actions.map((action) => <button key={action.label} type="button" onClick={() => setView(action.view)}>{action.label}</button>)}
        </div>
      </div>)}
    </div>
  </section>;
}

type Notify = (type: "success" | "error", text: string) => void;

const stockWithdrawalReasons = [
  "Consumo pessoal",
  "Perda",
  "Avaria",
  "Vencimento",
  "Brinde",
  "Ajuste de inventario",
  "Outro"
];

function Products({ products, categories, orders, onSaved, notify, can, isAdmin }: { products: Product[]; categories: ProductCategory[]; orders: Order[]; onSaved: () => void; notify: Notify; can: (permission: string) => boolean; isAdmin: boolean }) {
  const [imageUrl, setImageUrl] = useState("");
  const [editing, setEditing] = useState<Product | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [productName, setProductName] = useState("");
  const [brand, setBrand] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [skuEditable, setSkuEditable] = useState(false);
  const [skuDraft, setSkuDraft] = useState("");
  const [quickCategoryOpen, setQuickCategoryOpen] = useState(false);
  const [quickCategoryName, setQuickCategoryName] = useState("");
  const [quickCategoryDescription, setQuickCategoryDescription] = useState("");
  const [quickCategorySaving, setQuickCategorySaving] = useState(false);
  const [imageSearchOpen, setImageSearchOpen] = useState(false);
  const [imageSearchQuery, setImageSearchQuery] = useState("");
  const [imageUrlToImport, setImageUrlToImport] = useState("");
  const [imageSearchResults, setImageSearchResults] = useState<ImageSearchResult[]>([]);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageSearching, setImageSearching] = useState(false);
  const [imageImporting, setImageImporting] = useState("");
  const [viewing, setViewing] = useState<Product | null>(null);
  const [stocking, setStocking] = useState<Product | null>(null);
  const [stockSaving, setStockSaving] = useState(false);
  const [removingProductId, setRemovingProductId] = useState("");
  const [lotQuantity, setLotQuantity] = useState(0);
  const [lotTotalCost, setLotTotalCost] = useState(0);
  const [stockMovementType, setStockMovementType] = useState<"in" | "out">("in");
  const [stockOutReason, setStockOutReason] = useState(stockWithdrawalReasons[0]);
  const [stockOutReasonOther, setStockOutReasonOther] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [categoryDraft, setCategoryDraft] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [page, setPage] = useState(1);
  const formKey = editing?.id ?? "new-product";
  const filteredProducts = products.filter((product) => {
    if (!product.active) return false;
    const nameMatches = textMatches(product.name, nameFilter);
    const categoryMatches = !categoryFilter || product.categoryId === categoryFilter;
    return nameMatches && categoryMatches;
  });
  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / 10));
  const currentPage = Math.min(page, totalPages);
  const paginatedProducts = filteredProducts.slice((currentPage - 1) * 10, currentPage * 10);
  const selectedCategory = categories.find((category) => category.id === categoryId);
  const generatedSku = editing?.sku ?? `${skuPreviewPart(selectedCategory?.name ?? "", "SEM")}-${skuPreviewPart(brand || productName, "MAR")}-###`;
  const skuValue = skuEditable ? skuDraft : generatedSku;
  const stockUnitCost = lotQuantity > 0 ? lotTotalCost / lotQuantity : 0;
  const stockSalePrice = Number(stocking?.salePrice ?? 0);
  const stockPotentialRevenue = lotQuantity * stockSalePrice;
  const stockPotentialProfit = stockPotentialRevenue - lotTotalCost;

  function readImage(file?: File) {
    if (!file) {
      setImageFile(null);
      return setImageUrl("");
    }
    setImageFile(file);
    setImageUrl(URL.createObjectURL(file));
  }

  function startEdit(product: Product) {
    setEditing(product);
    setProductName(product.name);
    setBrand(product.brand ?? "");
    setCategoryId(product.categoryId ?? "");
    setImageUrl(product.imageUrl ?? "");
    setImageFile(null);
    setSkuDraft(product.sku ?? "");
    setSkuEditable(false);
    setModalOpen(true);
  }

  function cancelEdit() {
    setEditing(null);
    setImageUrl("");
    setImageFile(null);
    setProductName("");
    setBrand("");
    setCategoryId("");
    setSkuDraft("");
    setSkuEditable(false);
    setQuickCategoryOpen(false);
    setImageSearchOpen(false);
    setImageSearchQuery("");
    setImageUrlToImport("");
    setImageSearchResults([]);
    setQuickCategoryName("");
    setQuickCategoryDescription("");
    setModalOpen(false);
  }

  async function createQuickCategory() {
    if (quickCategorySaving) return;
    if (quickCategoryName.trim().length < 2) {
      notify("error", "Informe o nome da categoria.");
      return;
    }
    setQuickCategorySaving(true);
    try {
      const created = await api.createCategory({ name: uppercaseInput(quickCategoryName.trim()), description: uppercaseInput(quickCategoryDescription.trim()), active: true });
      setCategoryId(created.id);
      setQuickCategoryOpen(false);
      setQuickCategoryName("");
      setQuickCategoryDescription("");
      await onSaved();
      notify("success", "Categoria cadastrada e selecionada.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel cadastrar a categoria.");
    } finally {
      setQuickCategorySaving(false);
    }
  }

  function openImageSearch() {
    const query = [productName, brand, selectedCategory?.name].filter(Boolean).join(" ");
    setImageSearchQuery(query);
    setImageSearchOpen(true);
    setImageSearchResults([]);
  }

  async function searchImages() {
    if (imageSearchQuery.trim().length < 2) {
      notify("error", "Informe um termo para buscar imagem.");
      return;
    }
    setImageSearching(true);
    try {
      setImageSearchResults(await api.searchImages(imageSearchQuery.trim()));
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel buscar imagens.");
    } finally {
      setImageSearching(false);
    }
  }

  async function selectOnlineImage(result: ImageSearchResult) {
    setImageImporting(result.id);
    try {
      const imported = await api.importImage(result.url);
      setImageUrl(imported.imageUrl);
      setImageFile(null);
      setImageSearchOpen(false);
      notify("success", "Imagem adicionada ao produto.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel importar a imagem.");
    } finally {
      setImageImporting("");
    }
  }

  async function importImageFromUrl() {
    if (!imageUrlToImport.trim()) {
      notify("error", "Informe a URL da imagem.");
      return;
    }
    setImageImporting("url");
    try {
      const imported = await api.importImage(imageUrlToImport.trim());
      setImageUrl(imported.imageUrl);
      setImageFile(null);
      setImageSearchOpen(false);
      setImageUrlToImport("");
      notify("success", "Imagem importada pela URL.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel importar a imagem.");
    } finally {
      setImageImporting("");
    }
  }

  function openGoogleImages() {
    const query = imageSearchQuery.trim() || [productName, brand, selectedCategory?.name].filter(Boolean).join(" ");
    window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(query)}`, "_blank", "noopener,noreferrer");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const formElement = event.currentTarget;
    setSaving(true);
    try {
      const form = new FormData(formElement);
      const uploadedImageUrl = imageFile ? (await api.uploadProductImage(imageFile, String(form.get("name") ?? productName))).imageUrl : imageUrl;
      const payload = {
        ...Object.fromEntries(form),
        imageUrl: uploadedImageUrl,
        name: uppercaseInput(String(form.get("name") ?? "")),
        brand: uppercaseInput(String(form.get("brand") ?? "")),
        sku: uppercaseInput(String(form.get("sku") || generatedSku)),
        description: uppercaseInput(String(form.get("description") ?? "")),
        costPrice: editing?.costPrice ?? "0",
        salePrice: parseMoneyInput(form.get("salePrice")),
        stock: editing?.stock ?? 0,
        manufactureDate: editing?.manufactureDate ?? "",
        expirationDate: editing?.expirationDate ?? ""
      };
      if (editing) {
        await api.updateProduct(editing.id, payload);
      } else {
        await api.createProduct(payload);
      }
      formElement.reset();
      cancelEdit();
      await onSaved();
      notify("success", editing ? "Produto atualizado com sucesso." : "Produto cadastrado com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel salvar o produto.");
    } finally {
      setSaving(false);
    }
  }

  async function submitStock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stockSaving) return;
    if (!stocking) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setStockSaving(true);
    try {
      await api.stock({
        productId: stocking.id,
        type: stockMovementType,
        quantity: Number(form.get("quantity")),
        totalCost: stockMovementType === "in" ? parseMoneyInput(form.get("totalCost")) : undefined,
        costPrice: stockMovementType === "in" ? parseMoneyInput(form.get("costPrice")) : undefined,
        salePrice: stockMovementType === "in" ? parseMoneyInput(form.get("salePrice")) || Number(stocking.salePrice) : undefined,
        manufactureDate: String(form.get("manufactureDate") ?? ""),
        expirationDate: String(form.get("expirationDate") ?? ""),
        note: stockMovementType === "out" ? (stockOutReason === "Outro" ? stockOutReasonOther : stockOutReason) : String(form.get("note") ?? "")
      });
      formElement.reset();
      setStocking(null);
      setLotQuantity(0);
      setLotTotalCost(0);
      setStockMovementType("in");
      setStockOutReason(stockWithdrawalReasons[0]);
      setStockOutReasonOther("");
      await onSaved();
      notify("success", "Lote adicionado com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel adicionar estoque.");
    } finally {
      setStockSaving(false);
    }
  }

  async function removeProduct(product: Product) {
    if (removingProductId) return;
    if (!window.confirm(`Remover o produto "${product.name}"?`)) return;
    setRemovingProductId(product.id);
    try {
      await api.deleteProduct(product.id);
      await onSaved();
      notify("success", "Produto removido com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel remover o produto.");
    } finally {
      setRemovingProductId("");
    }
  }

  return <section className="stack">
    {modalOpen && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide product-modal">
        <div className="product-modal-hero">
          <div>
            <span className="badge">{editing ? "Edicao" : "Cadastro"}</span>
            <h2>{editing ? "Editar produto" : "Novo produto"}</h2>
          </div>
          <button className="icon-btn" type="button" title="Fechar" onClick={cancelEdit}><X size={16} /></button>
        </div>
        <form key={formKey} className="product-form" onSubmit={submit}>
          <div className="product-form-main">
            <div className="form-section">
              <h3>Identificacao</h3>
              <div className="form two">
                <label>Nome<input name="name" value={productName} onChange={(event) => setProductName(uppercaseInput(event.target.value))} required /></label>
                <label>Marca<input name="brand" value={brand} onChange={(event) => setBrand(uppercaseInput(event.target.value))} placeholder="Ex: Dellys" /></label>
                <div className="category-picker">
                  <label>Categoria<select name="categoryId" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                    <option value="">Sem categoria</option>
                    {categories.filter((category) => category.active).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                  </select></label>
                  {can("categories.create") && <button className="secondary" type="button" onClick={() => setQuickCategoryOpen(true)}><PackagePlus size={16} />Nova</button>}
                </div>
                <div className="sku-picker">
                  <label>SKU<input name="sku" value={skuValue} readOnly={!skuEditable} onChange={(event) => setSkuDraft(uppercaseInput(event.target.value))} /></label>
                  <button className={`icon-btn action-icon ${skuEditable ? "action-stock" : "action-edit"}`} type="button" title={skuEditable ? "Usar SKU automatico" : "Editar SKU"} aria-label={skuEditable ? "Usar SKU automatico" : "Editar SKU"} onClick={() => { if (skuEditable) { setSkuEditable(false); setSkuDraft(""); } else { setSkuDraft(generatedSku); setSkuEditable(true); } }}><Edit3 size={16} /></button>
                </div>
                <label>Preco de venda<input name="salePrice" type="text" inputMode="numeric" defaultValue={editing ? formatMoneyInput(editing.salePrice) : ""} onInput={(event) => maskMoneyInput(event.currentTarget)} required /></label>
                <label>Estoque minimo<input name="minStock" type="number" defaultValue={editing?.minStock ?? 0} required /></label>
              </div>
            </div>
            <div className="form-section">
              <h3>Descricao</h3>
              <label><textarea name="description" defaultValue={editing?.description ?? ""} onChange={(event) => { event.currentTarget.value = uppercaseInput(event.currentTarget.value); }} /></label>
            </div>
          </div>
          <div className="product-form-side">
            <div className="form-section image-section">
              <h3>Imagem</h3>
              <div className={`product-image-manager ${imageUrl ? "has-image" : ""}`}>
                <label className="upload-field">
                  <span className="upload-box product-upload-box">
                    {imageUrl ? <img src={assetUrl(imageUrl)} alt="Previa do produto" /> : <span className="upload-empty-state"><ImagePlus size={30} /><strong>Adicionar foto</strong><small>PNG, JPG ou WEBP</small></span>}
                    <input type="file" accept="image/*" onChange={(event) => readImage(event.target.files?.[0])} />
                  </span>
                </label>
                <div className="image-actions">
                  <label className="secondary image-action-button">
                    <ImagePlus size={16} />{imageUrl ? "Trocar imagem" : "Selecionar imagem"}
                    <input type="file" accept="image/*" onChange={(event) => readImage(event.target.files?.[0])} />
                  </label>
                  <button className="secondary" type="button" onClick={openImageSearch}><Eye size={16} />Pesquisar</button>
                  {imageUrl && <button className="secondary danger-button" type="button" onClick={() => { setImageFile(null); setImageUrl(""); }}><Trash2 size={16} />Remover</button>}
                </div>
              </div>
            </div>
            <button className="primary product-submit-button" type="submit" disabled={saving}><PackagePlus size={18} />{saving ? "Salvando..." : editing ? "Salvar alteracoes" : "Salvar produto"}</button>
          </div>
        </form>
      </div>
    </div>}
    {quickCategoryOpen && <div className="modal-backdrop modal-backdrop-front" role="dialog" aria-modal="true">
      <div className="modal product-view-modal">
        <div className="card-title-row">
          <h2>Nova categoria</h2>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => setQuickCategoryOpen(false)}><X size={16} /></button>
        </div>
        <form className="form" onSubmit={(event) => { event.preventDefault(); createQuickCategory(); }}>
          <label>Nome<input value={quickCategoryName} onChange={(event) => setQuickCategoryName(uppercaseInput(event.target.value))} placeholder="Ex: Sorvetes" required /></label>
          <label>Descricao<textarea value={quickCategoryDescription} onChange={(event) => setQuickCategoryDescription(uppercaseInput(event.target.value))} placeholder="Opcional" /></label>
          <div className="confirm-actions">
            <button className="secondary" type="button" onClick={() => setQuickCategoryOpen(false)}>Cancelar</button>
            <button className="primary" type="submit" disabled={quickCategorySaving}><PackagePlus size={18} />{quickCategorySaving ? "Salvando..." : "Salvar categoria"}</button>
          </div>
        </form>
      </div>
    </div>}
    {imageSearchOpen && <div className="modal-backdrop modal-backdrop-front" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <div className="card-title-row">
          <h2>Pesquisar imagem</h2>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => setImageSearchOpen(false)}><X size={16} /></button>
        </div>
        <div className="image-search-form">
          <label>Buscar por nome, marca ou categoria<input value={imageSearchQuery} onChange={(event) => setImageSearchQuery(uppercaseInput(event.target.value))} placeholder="Ex: salgadinho dellys" /></label>
          <button className="primary" type="button" disabled={imageSearching} onClick={searchImages}>{imageSearching ? "Buscando..." : "Buscar"}</button>
          <button className="secondary" type="button" onClick={openGoogleImages}>Abrir Google</button>
        </div>
        <div className="image-url-import">
          <label>Ou cole a URL da imagem<input value={imageUrlToImport} onChange={(event) => setImageUrlToImport(event.target.value)} placeholder="https://..." /></label>
          <button className="secondary" type="button" disabled={imageImporting === "url"} onClick={importImageFromUrl}>{imageImporting === "url" ? "Importando..." : "Importar URL"}</button>
        </div>
        <div className="image-search-grid">
          {imageSearching && Array.from({ length: 8 }).map((_, index) => <div className="image-result-skeleton" key={index}>
            <span />
            <strong />
            <small />
          </div>)}
          {!imageSearching && imageSearchResults.length === 0 && <p className="muted">Busque uma imagem e selecione a melhor opcao para o produto.</p>}
          {!imageSearching && imageSearchResults.map((result) => <button className="image-result-card" type="button" key={result.id} onClick={() => selectOnlineImage(result)} disabled={imageImporting === result.id}>
            <img src={result.thumbnail} alt={result.title} />
            <span>{imageImporting === result.id ? "Importando..." : result.title}</span>
            {(result.creator || result.source) && <small>{[result.creator, result.source].filter(Boolean).join(" - ")}</small>}
          </button>)}
        </div>
      </div>
    </div>}
    {viewing && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="card-title-row">
          <h2>Produto</h2>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => setViewing(null)}><X size={16} /></button>
        </div>
        <div className="product-view-card">
          <ProductImage product={viewing} />
          <div>
            <span className="badge">{viewing.category?.name ?? "Sem categoria"}</span>
            <h2>{viewing.name}</h2>
            <p className="muted">{viewing.brand ? `Marca: ${viewing.brand}` : "Sem marca informada"}</p>
          </div>
        </div>
        <div className="product-basic-grid">
          <div><span>Categoria</span><strong>{viewing.category?.name ?? "Sem categoria"}</strong></div>
          <div><span>Marca</span><strong>{viewing.brand || "-"}</strong></div>
          <div><span>SKU</span><strong>{viewing.sku || "-"}</strong></div>
          <div><span>Lote atual</span><strong>{viewing.lotCode || "-"}</strong></div>
          <div><span>Preco de venda</span><strong>{brl(viewing.salePrice)}</strong></div>
          <div><span>Estoque atual</span><strong>{viewing.stock}</strong></div>
        </div>
        {viewing.description && <div className="product-view-description"><span>Descricao</span><p>{viewing.description}</p></div>}
      </div>
    </div>}
    {stocking && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="card-title-row">
          <h2>Adicionar lote / movimentar estoque</h2>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => { setStocking(null); setLotQuantity(0); setLotTotalCost(0); setStockMovementType("in"); setStockOutReason(stockWithdrawalReasons[0]); setStockOutReasonOther(""); }}><X size={16} /></button>
        </div>
        <form className="form" onSubmit={submitStock}>
          <div className="product-view-card compact">
            <ProductImage product={stocking} />
            <div>
              <strong>{stocking.name}</strong>
              <span className="muted">{stocking.category?.name ?? "Sem categoria"}{stocking.brand ? ` - ${stocking.brand}` : ""}</span>
              <span className="muted">Estoque atual: {stocking.stock}</span>
            </div>
          </div>
          <label>Tipo<select value={stockMovementType} onChange={(event) => { setStockMovementType(event.target.value as "in" | "out"); setLotQuantity(0); setLotTotalCost(0); setStockOutReason(stockWithdrawalReasons[0]); setStockOutReasonOther(""); }}>
            <option value="in">Entrada</option>
            <option value="out">Saida</option>
          </select></label>
          <label>Quantidade<input name="quantity" type="number" min="1" required value={lotQuantity || ""} onChange={(event) => setLotQuantity(Number(event.target.value))} /></label>
          {stockMovementType === "in" && <>
            <label>Valor total pago<input name="totalCost" type="text" inputMode="numeric" required value={lotTotalCost ? formatMoneyInput(lotTotalCost) : ""} onChange={(event) => { maskMoneyInput(event.currentTarget); setLotTotalCost(parseMoneyInput(event.currentTarget.value)); }} /></label>
            <label>Custo por unidade<input name="costPrice" type="text" value={formatMoneyInput(stockUnitCost)} readOnly /></label>
            <label>Preco de venda<input name="salePrice" type="text" inputMode="numeric" defaultValue={formatMoneyInput(stocking.salePrice)} onInput={(event) => maskMoneyInput(event.currentTarget)} required /></label>
            <div className="stock-profit-preview">
              <div><span>Vai arrecadar</span><strong>{brl(stockPotentialRevenue)}</strong></div>
              <div><span>Lucro previsto</span><strong>{brl(stockPotentialProfit)}</strong></div>
            </div>
            <label>Data de fabricacao<input name="manufactureDate" type="date" /></label>
            <label>Data de validade<input name="expirationDate" type="date" /></label>
            <label>Observacao<input name="note" placeholder="Opcional" /></label>
          </>}
          {stockMovementType === "out" && <>
            <label>Motivo da retirada<select value={stockOutReason} onChange={(event) => setStockOutReason(event.target.value)}>
              {stockWithdrawalReasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
            </select></label>
            {stockOutReason === "Outro" && <label>Outro motivo<input required value={stockOutReasonOther} onChange={(event) => setStockOutReasonOther(event.target.value)} placeholder="Descreva o motivo" /></label>}
          </>}
          <button className="primary" type="submit" disabled={stockSaving}><PackagePlus size={18} />{stockSaving ? "Registrando..." : "Registrar"}</button>
        </form>
      </div>
    </div>}
    <ProductTable
      products={paginatedProducts}
      categories={categories}
      filters={{ name: nameDraft, categoryId: categoryDraft }}
      onFilterChange={(filters) => {
        setNameDraft(filters.name);
        setCategoryDraft(filters.categoryId);
      }}
      onSearch={() => {
        setNameFilter(nameDraft);
        setCategoryFilter(categoryDraft);
        setPage(1);
      }}
      headerAction={can("products.create") ? <button className="primary" type="button" onClick={() => { setEditing(null); setProductName(""); setBrand(""); setCategoryId(""); setSkuDraft(""); setSkuEditable(false); setImageUrl(""); setModalOpen(true); }}><PackagePlus size={18} />Novo produto</button> : null}
      onClearFilters={() => {
        setNameDraft("");
        setCategoryDraft("");
        setNameFilter("");
        setCategoryFilter("");
        setPage(1);
      }}
      pagination={{ page: currentPage, totalPages, totalItems: filteredProducts.length }}
      onPageChange={setPage}
      onView={setViewing}
      onAddStock={can("stock.move") ? (product) => { setStocking(product); setLotQuantity(0); setLotTotalCost(0); setStockMovementType("in"); setStockOutReason(stockWithdrawalReasons[0]); setStockOutReasonOther(""); } : undefined}
      onEdit={isAdmin ? startEdit : undefined}
      onRemove={isAdmin ? removeProduct : undefined}
      removingProductId={removingProductId}
    />
  </section>;
}

function Categories({ categories, products, onSaved, notify, can }: { categories: ProductCategory[]; products: Product[]; onSaved: () => void; notify: Notify; can: (permission: string) => boolean }) {
  const [editing, setEditing] = useState<ProductCategory | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState("");

  function openNew() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(category: ProductCategory) {
    setEditing(category);
    setModalOpen(true);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = {
      name: uppercaseInput(String(form.get("name") ?? "")),
      description: uppercaseInput(String(form.get("description") ?? "")),
      active: form.has("active")
    };
    setSaving(true);
    try {
      if (editing) {
        await api.updateCategory(editing.id, payload);
      } else {
        await api.createCategory(payload);
      }
      formElement.reset();
      setModalOpen(false);
      setEditing(null);
      await onSaved();
      notify("success", editing ? "Categoria atualizada com sucesso." : "Categoria cadastrada com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel salvar a categoria.");
    } finally {
      setSaving(false);
    }
  }

  async function remove(category: ProductCategory) {
    if (removingId) return;
    if (!window.confirm(`Desativar a categoria "${category.name}"?`)) return;
    setRemovingId(category.id);
    try {
      await api.deleteCategory(category.id);
      await onSaved();
      notify("success", "Categoria desativada com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel desativar a categoria.");
    } finally {
      setRemovingId("");
    }
  }

  return <section className="stack">
    {modalOpen && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="card-title-row">
          <h2>{editing ? "Editar categoria" : "Nova categoria"}</h2>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => setModalOpen(false)}><X size={16} /></button>
        </div>
        <form className="form" onSubmit={submit}>
          <label>Nome<input name="name" defaultValue={editing?.name ?? ""} onChange={(event) => { event.currentTarget.value = uppercaseInput(event.currentTarget.value); }} required /></label>
          <label>Descricao<textarea name="description" defaultValue={editing?.description ?? ""} onChange={(event) => { event.currentTarget.value = uppercaseInput(event.currentTarget.value); }} /></label>
          <label className="check-row"><input type="checkbox" name="active" defaultChecked={editing?.active ?? true} value="true" />Categoria ativa</label>
          <button className="primary" type="submit" disabled={saving}><PackagePlus size={18} />{saving ? "Salvando..." : "Salvar categoria"}</button>
        </form>
      </div>
    </div>}
    <div className="card table-wrap">
      <div className="section-heading">
        <h2>Categorias</h2>
        {can("categories.create") && <button className="primary" type="button" onClick={openNew}><PackagePlus size={18} />Nova categoria</button>}
      </div>
      <table>
        <thead><tr><th>Nome</th><th>Descricao</th><th>Produtos</th><th>Status</th><th>Acoes</th></tr></thead>
        <tbody>
          {categories.length === 0 && <tr><td colSpan={5}>Nenhuma categoria cadastrada.</td></tr>}
          {categories.map((category) => <tr key={category.id}>
            <td>{category.name}</td>
            <td>{category.description || "-"}</td>
            <td>{products.filter((product) => product.categoryId === category.id).length}</td>
            <td><span className="badge">{category.active ? "Ativa" : "Inativa"}</span></td>
            <td><div className="action-row">
              {can("categories.edit") && <button className="icon-btn action-icon action-edit" type="button" title="Editar categoria" aria-label={`Editar categoria ${category.name}`} onClick={() => openEdit(category)}><Edit3 size={16} /></button>}
              {can("categories.edit") && category.active && <button className="icon-btn action-icon action-remove" type="button" disabled={removingId === category.id} title="Desativar categoria" aria-label={`Desativar categoria ${category.name}`} onClick={() => remove(category)}><PowerOff size={16} /></button>}
            </div></td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>;
}

function ProductTable({
  products,
  categories = [],
  filters,
  onFilterChange,
  onSearch,
  onClearFilters,
  headerAction,
  pagination,
  onPageChange,
  onView,
  onAddStock,
  onEdit,
  onRemove,
  removingProductId = ""
}: {
  products: Product[];
  orders?: Order[];
  categories?: ProductCategory[];
  filters?: { name: string; categoryId: string };
  onFilterChange?: (filters: { name: string; categoryId: string }) => void;
  onSearch?: () => void;
  onClearFilters?: () => void;
  headerAction?: React.ReactNode;
  pagination?: { page: number; totalPages: number; totalItems: number };
  onPageChange?: (page: number) => void;
  onView?: (product: Product) => void;
  onAddStock?: (product: Product) => void;
  onEdit?: (product: Product) => void;
  onRemove?: (product: Product) => void;
  removingProductId?: string;
}) {
  const hasActions = Boolean(onView || onAddStock || onEdit || onRemove);
    return <div className="product-table-stack">
      {filters && onFilterChange && <div className="card product-filter-card">
      <div className="embedded-page-header">
        <div>
          <h1>Produtos</h1>
          <div className="muted">Produtos, estoque, financeiro e vendas no mesmo lugar</div>
        </div>
      </div>
      <div className="section-heading">
        <h2>Filtros</h2>
        {headerAction}
      </div>
      <div className="filters-grid product-filters">
      <label>Nome<input value={filters.name} onChange={(event) => onFilterChange({ ...filters, name: uppercaseInput(event.target.value) })} placeholder="Buscar produto" /></label>
      <label>Categoria<select value={filters.categoryId} onChange={(event) => onFilterChange({ ...filters, categoryId: event.target.value })}>
        <option value="">Todas</option>
        {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select></label>
      <div className="filter-actions">
        <button className="primary" type="button" onClick={onSearch}>Buscar</button>
        <button className="secondary" type="button" onClick={onClearFilters}>Limpar filtros</button>
      </div>
      </div>
    </div>}
    <div className="card table-wrap product-list-card">
      <h2>Produtos</h2>
      <table className="desktop-product-table">
      <thead><tr><th>Produto</th><th>Categoria</th><th>Marca</th>{hasActions && <th>Acoes</th>}</tr></thead>
      <tbody>
        {products.length === 0 && <tr><td colSpan={hasActions ? 4 : 3}>Nenhum produto encontrado.</td></tr>}
        {products.map((product) => <tr key={product.id}>
            <td><div className="product-cell"><ProductImage product={product} /><span>{product.name}</span></div></td>
            <td className="product-mobile-hide">{product.category?.name ?? "-"}</td>
            <td className="product-mobile-hide">{product.brand || "-"}</td>
            {hasActions && <td><div className="action-row product-actions">
              {onView && <button className="icon-btn action-icon action-view" title="Visualizar produto" onClick={() => onView(product)}><Eye size={16} /></button>}
              {onAddStock && <button className="icon-btn action-icon action-stock" title="Adicionar estoque" onClick={() => onAddStock(product)}><PackagePlus size={16} /></button>}
              {onEdit && <button className="icon-btn action-icon action-edit" title="Editar produto" onClick={() => onEdit(product)}><Edit3 size={16} /></button>}
              {onRemove && <button className="icon-btn action-icon action-remove" disabled={removingProductId === product.id} title="Remover produto" onClick={() => onRemove(product)}><Trash2 size={16} /></button>}
            </div></td>}
          </tr>)}
      </tbody>
    </table>
      <div className="mobile-product-cards">
        {products.length === 0 && <p className="muted">Nenhum produto encontrado.</p>}
        {products.map((product) => <div className="mobile-product-card" key={product.id}>
          <ProductImage product={product} />
          <div>
            <strong>{product.name}</strong>
            <span>{product.category?.name ?? "Sem categoria"}</span>
            {product.brand && <span>{product.brand}</span>}
          </div>
          {hasActions && <div className="mobile-product-actions">
            {onView && <button className="secondary action-view-button" type="button" onClick={() => onView(product)}><Eye size={16} />Visualizar</button>}
            {onAddStock && <button className="secondary action-view-button" type="button" onClick={() => onAddStock(product)}><PackagePlus size={16} />Estoque</button>}
            {onEdit && <button className="secondary action-view-button" type="button" onClick={() => onEdit(product)}><Edit3 size={16} />Editar</button>}
            {onRemove && <button className="secondary danger-button action-view-button" type="button" disabled={removingProductId === product.id} onClick={() => onRemove(product)}><Trash2 size={16} />{removingProductId === product.id ? "Removendo..." : "Remover"}</button>}
          </div>}
        </div>)}
      </div>
    {pagination && onPageChange && <div className="pagination-row">
      <span>{pagination.totalItems} produto(s)</span>
      <div>
        <button className="secondary" type="button" disabled={pagination.page <= 1} onClick={() => onPageChange(pagination.page - 1)}>Anterior</button>
        <strong>{pagination.page} / {pagination.totalPages}</strong>
        <button className="secondary" type="button" disabled={pagination.page >= pagination.totalPages} onClick={() => onPageChange(pagination.page + 1)}>Proxima</button>
      </div>
    </div>}
    </div>
  </div>;
}

function ProductImage({ product }: { product: Product }) {
  return product.imageUrl
    ? <img className="product-thumb" src={assetUrl(product.imageUrl)} alt={product.name} />
    : <div className="product-thumb empty"><Boxes size={18} /></div>;
}

function LotsPage({ products, onSaved, notify, can }: { products: Product[]; onSaved: () => void; notify: Notify; can: (permission: string) => boolean }) {
  const [viewingProduct, setViewingProduct] = useState<Product | null>(null);
  const [editingLot, setEditingLot] = useState<ProductLot | null>(null);
  const [lotSalePrice, setLotSalePrice] = useState(0);
  const [savingLot, setSavingLot] = useState(false);
  const productsWithLots = products
    .filter((product) => product.active && (product.lots?.length ?? 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const viewingLots = (viewingProduct?.lots ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const viewingRemainingRevenue = viewingLots.reduce((sum, lot) => sum + lot.currentStock * Number(lot.salePrice), 0);
  const viewingRemainingCost = viewingLots.reduce((sum, lot) => sum + lot.currentStock * Number(lot.costPrice), 0);
  const viewingRemainingProfit = viewingRemainingRevenue - viewingRemainingCost;
  const viewingTotalRevenue = viewingLots.reduce((sum, lot) => sum + lot.initialStock * Number(lot.salePrice), 0);
  const viewingTotalCost = viewingLots.reduce((sum, lot) => sum + lot.initialStock * Number(lot.costPrice), 0);
  const viewingTotalProfit = viewingTotalRevenue - viewingTotalCost;

  function openLotEdit(lot: ProductLot) {
    setEditingLot(lot);
    setLotSalePrice(Number(lot.salePrice));
  }

  async function submitLotPrice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingLot) return;
    setSavingLot(true);
    try {
      const updatedLot = await api.updateLot(editingLot.id, { salePrice: parseMoneyInput(new FormData(event.currentTarget).get("salePrice")) });
      setViewingProduct((current) => current ? {
        ...current,
        lots: current.lots?.map((lot) => lot.id === updatedLot.id ? updatedLot : lot)
      } : current);
      await onSaved();
      notify("success", "Preco do lote atualizado para o estoque restante.");
      setEditingLot(null);
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel atualizar o lote.");
    } finally {
      setSavingLot(false);
    }
  }

  return <section className="stack">
    {editingLot && <div className="modal-backdrop modal-backdrop-front" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="card-title-row">
          <div>
            <span className="badge">Editar lote</span>
            <h2>{editingLot.code}</h2>
          </div>
          <button className="icon-btn" type="button" aria-label="Fechar" onClick={() => setEditingLot(null)}><X size={16} /></button>
        </div>
        <form className="form" onSubmit={submitLotPrice}>
          <div className="stock-profit-preview">
            <div><span>Estoque restante</span><strong>{editingLot.currentStock}</strong></div>
            <div><span>Preco atual</span><strong>{brl(editingLot.salePrice)}</strong></div>
          </div>
          <label>Novo preco de venda<input name="salePrice" type="text" inputMode="numeric" required value={lotSalePrice ? formatMoneyInput(lotSalePrice) : ""} onChange={(event) => { maskMoneyInput(event.currentTarget); setLotSalePrice(parseMoneyInput(event.currentTarget.value)); }} /></label>
          <button className="primary" type="submit" disabled={savingLot || editingLot.currentStock <= 0}><Edit3 size={18} />{savingLot ? "Salvando..." : "Salvar preco do lote"}</button>
        </form>
      </div>
    </div>}
    {viewingProduct && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide lots-modal">
        <div className="card-title-row">
          <div>
            <span className="badge">Lotes</span>
            <h2>{viewingProduct.name}</h2>
          </div>
          <button className="icon-btn" type="button" aria-label="Fechar" onClick={() => setViewingProduct(null)}><X size={16} /></button>
        </div>
        <div className="product-view-card compact lot-product-summary">
          <ProductImage product={viewingProduct} />
          <div className="lot-product-info">
            <strong>{viewingProduct.name}</strong>
            <span className="muted">{viewingProduct.category?.name ?? "Sem categoria"}{viewingProduct.brand ? ` - ${viewingProduct.brand}` : ""}</span>
            <span className="muted">Estoque atual: {viewingProduct.stock}</span>
          </div>
        </div>
        <div className="stock-profit-preview lot-profit-summary">
          <div><span>Lucro que falta</span><strong>{brl(viewingRemainingProfit)}</strong></div>
          <div><span>Lucro total previsto</span><strong>{brl(viewingTotalProfit)}</strong></div>
        </div>
        <div className="table-wrap lots-table-panel">
          <table>
            <thead><tr><th>Lote</th><th>Inicial</th><th>Atual</th><th>Custo un.</th><th>Total pago</th><th>Venda</th><th>Fabricacao</th><th>Validade</th><th>Acoes</th></tr></thead>
            <tbody>
              {viewingLots.length === 0 && <tr><td colSpan={9}>Nenhum lote registrado.</td></tr>}
              {viewingLots.map((lot) => <tr key={lot.id}>
                <td>{lot.code}</td>
                <td>{lot.initialStock}</td>
                <td>{lot.currentStock}</td>
                <td>{brl(lot.costPrice)}</td>
                <td>{lot.totalCost !== undefined ? brl(lot.totalCost) : "-"}</td>
                <td>{brl(lot.salePrice)}</td>
                <td>{lot.manufactureDate ? dateLabel(lot.manufactureDate) : "-"}</td>
                <td>{lot.expirationDate ? dateLabel(lot.expirationDate) : "-"}</td>
                <td>{can("stock.move") && <button className="icon-btn action-icon action-edit" type="button" title="Editar preco do lote" aria-label={`Editar preco do lote ${lot.code}`} disabled={lot.currentStock <= 0} onClick={() => openLotEdit(lot)}><Edit3 size={16} /></button>}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </div>}
    <div className="card table-wrap">
      <h2>Produtos com lotes</h2>
      <table>
        <thead><tr><th>Produto</th><th>Categoria</th><th>Marca</th><th>Lotes</th><th>Estoque atual</th><th>Acoes</th></tr></thead>
        <tbody>
          {productsWithLots.length === 0 && <tr><td colSpan={6}>Nenhum lote registrado.</td></tr>}
          {productsWithLots.map((product) => {
            return <tr key={product.id}>
            <td><div className="product-cell"><ProductImage product={product} /><span>{product.name}</span></div></td>
            <td>{product.category?.name ?? "-"}</td>
            <td>{product.brand || "-"}</td>
            <td>{product.lots?.length ?? 0}</td>
            <td>{product.stock}</td>
            <td><button className="icon-btn action-icon action-view" type="button" title="Visualizar lotes" aria-label={`Visualizar lotes de ${product.name}`} onClick={() => setViewingProduct(product)}><Eye size={16} /></button></td>
          </tr>;
          })}
        </tbody>
      </table>
    </div>
  </section>;
}

function stockSituation(product: Product) {
  if (product.stock <= 0) return { label: "Sem estoque", className: "stock-out" };
  if (product.stock <= product.minStock) return { label: "Estoque baixo", className: "stock-low" };
  return { label: "Disponivel", className: "stock-ok" };
}

function movementTypeLabel(type: StockMovement["type"]) {
  return type === "in" ? "Entrada" : type === "out" ? "Saida" : "Ajuste";
}

function Stock({ products, movements, categories, onSaved, notify, can }: { products: Product[]; movements: StockMovement[]; categories: ProductCategory[]; onSaved: () => void; notify: Notify; can: (permission: string) => boolean }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [viewing, setViewing] = useState<Product | null>(null);
  const [selectedStockProductId, setSelectedStockProductId] = useState("");
  const [saving, setSaving] = useState(false);
  const [draftFilters, setDraftFilters] = useState({ name: "", categoryId: "", brand: "" });
  const [filters, setFilters] = useState({ name: "", categoryId: "", brand: "" });
  const [lotQuantity, setLotQuantity] = useState(0);
  const [lotTotalCost, setLotTotalCost] = useState(0);
  const [movementType, setMovementType] = useState<"in" | "out">("in");
  const [outReason, setOutReason] = useState(stockWithdrawalReasons[0]);
  const [outReasonOther, setOutReasonOther] = useState("");
  const [stockMovementFilter, setStockMovementFilter] = useState<"all" | "in" | "out">("all");
  const [stockMovementPage, setStockMovementPage] = useState(1);
  const filteredProducts = products.filter((product) => {
    if (!product.active) return false;
    const nameMatches = textMatches(product.name, filters.name);
    const categoryMatches = !filters.categoryId || product.categoryId === filters.categoryId;
    const brandMatches = !filters.brand || textMatches(product.brand, filters.brand);
    return nameMatches && categoryMatches && brandMatches;
  });

  function clearFilters() {
    const emptyFilters = { name: "", categoryId: "", brand: "" };
    setDraftFilters(emptyFilters);
    setFilters(emptyFilters);
  }

  function openStockMovement(product?: Product) {
    if (!product) return;
    setSelectedStockProductId(product.id);
    setMovementType("in");
    setOutReason(stockWithdrawalReasons[0]);
    setOutReasonOther("");
    setLotQuantity(0);
    setLotTotalCost(0);
    setModalOpen(true);
  }

  const selectedStockProduct = products.find((product) => product.id === selectedStockProductId);
  const unitCost = lotQuantity > 0 ? lotTotalCost / lotQuantity : 0;
  const selectedSalePrice = Number(selectedStockProduct?.salePrice ?? 0);
  const potentialRevenue = lotQuantity * selectedSalePrice;
  const potentialProfit = potentialRevenue - lotTotalCost;
  const viewingMovements = viewing
    ? movements.filter((movement) => movement.productId === viewing.id).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];
  const filteredViewingMovements = viewingMovements.filter((movement) => stockMovementFilter === "all" || movement.type === stockMovementFilter);
  const stockMovementTotalPages = Math.max(1, Math.ceil(filteredViewingMovements.length / 10));
  const stockMovementCurrentPage = Math.min(stockMovementPage, stockMovementTotalPages);
  const paginatedViewingMovements = filteredViewingMovements.slice((stockMovementCurrentPage - 1) * 10, stockMovementCurrentPage * 10);

  function openStockDetails(product: Product) {
    setViewing(product);
    setStockMovementFilter("all");
    setStockMovementPage(1);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setSaving(true);
    try {
      const form = new FormData(formElement);
      await api.stock({
        productId: selectedStockProductId,
        type: movementType,
        quantity: Number(form.get("quantity")),
        totalCost: movementType === "in" ? parseMoneyInput(form.get("totalCost")) : undefined,
        costPrice: movementType === "in" ? parseMoneyInput(form.get("costPrice")) : undefined,
        salePrice: movementType === "in" ? parseMoneyInput(form.get("salePrice")) || Number(selectedStockProduct?.salePrice ?? 0) : undefined,
        manufactureDate: String(form.get("manufactureDate") ?? ""),
        expirationDate: String(form.get("expirationDate") ?? ""),
        note: movementType === "out" ? (outReason === "Outro" ? outReasonOther : outReason) : String(form.get("note") ?? "")
      });
      formElement.reset();
      setModalOpen(false);
      setLotQuantity(0);
      setLotTotalCost(0);
      setOutReason(stockWithdrawalReasons[0]);
      setOutReasonOther("");
      await onSaved();
      notify("success", "Estoque atualizado com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel movimentar o estoque.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="stack">
    {modalOpen && selectedStockProduct && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="card-title-row">
          <h2>Adicionar lote / movimentar estoque</h2>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => { setModalOpen(false); setLotQuantity(0); setLotTotalCost(0); setOutReason(stockWithdrawalReasons[0]); setOutReasonOther(""); }}><X size={16} /></button>
        </div>
        <form key={selectedStockProductId} className="form" onSubmit={submit}>
          <div className="product-view-card compact stock-movement-product">
            <ProductImage product={selectedStockProduct} />
            <div>
              <strong>{selectedStockProduct.name}</strong>
              <span className="muted">{selectedStockProduct.category?.name ?? "Sem categoria"}{selectedStockProduct.brand ? ` - ${selectedStockProduct.brand}` : ""}</span>
              <span className="muted">Estoque atual: {selectedStockProduct.stock}</span>
            </div>
          </div>
          <label>Tipo<select value={movementType} onChange={(event) => { setMovementType(event.target.value as "in" | "out"); setLotQuantity(0); setLotTotalCost(0); setOutReason(stockWithdrawalReasons[0]); setOutReasonOther(""); }}>
            <option value="in">Entrada</option>
            <option value="out">Saida</option>
          </select></label>
          <label>Quantidade<input name="quantity" type="number" min="1" required value={lotQuantity || ""} onChange={(event) => setLotQuantity(Number(event.target.value))} /></label>
          {movementType === "in" && <>
            <label>Valor total pago<input name="totalCost" type="text" inputMode="numeric" value={lotTotalCost ? formatMoneyInput(lotTotalCost) : ""} onChange={(event) => { maskMoneyInput(event.currentTarget); setLotTotalCost(parseMoneyInput(event.currentTarget.value)); }} /></label>
            <label>Custo por unidade<input name="costPrice" type="text" value={formatMoneyInput(unitCost)} readOnly /></label>
            <label>Preco de venda<input name="salePrice" type="text" inputMode="numeric" defaultValue={formatMoneyInput(selectedStockProduct.salePrice)} onInput={(event) => maskMoneyInput(event.currentTarget)} /></label>
            <div className="stock-profit-preview">
              <div><span>Vai arrecadar</span><strong>{brl(potentialRevenue)}</strong></div>
              <div><span>Lucro previsto</span><strong>{brl(potentialProfit)}</strong></div>
            </div>
            <label>Data de fabricacao<input name="manufactureDate" type="date" /></label>
            <label>Data de validade<input name="expirationDate" type="date" /></label>
            <label>Observacao<input name="note" placeholder="Opcional" /></label>
          </>}
          {movementType === "out" && <>
            <label>Motivo da retirada<select value={outReason} onChange={(event) => setOutReason(event.target.value)}>
              {stockWithdrawalReasons.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
            </select></label>
            {outReason === "Outro" && <label>Outro motivo<input required value={outReasonOther} onChange={(event) => setOutReasonOther(event.target.value)} placeholder="Descreva o motivo" /></label>}
          </>}
          <button className="primary" type="submit" disabled={saving}><PackagePlus size={18} />{saving ? "Registrando..." : "Registrar"}</button>
        </form>
      </div>
    </div>}
    {viewing && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide stock-detail-modal">
        <div className="card-title-row">
          <h2>Detalhes do estoque</h2>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => setViewing(null)}><X size={16} /></button>
        </div>
        <div className="stock-detail-header">
          <ProductImage product={viewing} />
          <div>
            <span className="badge">Produto</span>
            <h2>{viewing.name}</h2>
            <span className={`stock-badge ${stockSituation(viewing).className}`}>{stockSituation(viewing).label}</span>
          </div>
        </div>
        <div className="stock-info-grid">
          <div><span>Categoria</span><strong>{viewing.category?.name ?? "-"}</strong></div>
          <div><span>Marca</span><strong>{viewing.brand || "-"}</strong></div>
          <div><span>SKU</span><strong>{viewing.sku || "-"}</strong></div>
          <div><span>Lote atual</span><strong>{viewing.lotCode || "-"}</strong></div>
          <div><span>Quantidade</span><strong>{viewing.stock}</strong></div>
          <div><span>Estoque minimo</span><strong>{viewing.minStock}</strong></div>
          <div><span>Venda</span><strong>{brl(viewing.salePrice)}</strong></div>
        </div>
        {viewing.description && <div className="stock-description"><span>Descricao</span><p>{viewing.description}</p></div>}
        <div className="table-wrap stock-movements-panel">
          <div className="section-heading stock-movement-heading">
            <div>
              <h2>Movimentacoes de estoque</h2>
              <p className="muted">Ultimas movimentacoes registradas para este produto.</p>
            </div>
            <label>Tipo<select value={stockMovementFilter} onChange={(event) => { setStockMovementFilter(event.target.value as "all" | "in" | "out"); setStockMovementPage(1); }}>
              <option value="all">Ambas</option>
              <option value="in">Entrada</option>
              <option value="out">Saida</option>
            </select></label>
          </div>
          <table>
            <thead><tr><th>Data</th><th>Tipo</th><th>Quantidade</th><th>Lote</th><th>Custo un.</th><th>Total pago</th><th>Fabricacao</th><th>Validade</th><th>Observacao</th></tr></thead>
            <tbody>
              {paginatedViewingMovements.length === 0 && <tr><td colSpan={9}>Nenhuma movimentacao registrada.</td></tr>}
              {paginatedViewingMovements.map((movement) => <tr key={movement.id}>
                <td>{dateLabel(movement.createdAt)}</td>
                <td><span className={`stock-badge ${movement.type === "in" ? "stock-ok" : movement.type === "out" ? "stock-out" : "stock-low"}`}>{movementTypeLabel(movement.type)}</span></td>
                <td>{movement.quantity}</td>
                <td>{movement.lotCode ?? "-"}</td>
                <td>{movement.costPrice !== undefined ? brl(movement.costPrice) : "-"}</td>
                <td>{movement.totalCost !== undefined ? brl(movement.totalCost) : "-"}</td>
                <td>{movement.manufactureDate ? dateLabel(movement.manufactureDate) : "-"}</td>
                <td>{movement.expirationDate ? dateLabel(movement.expirationDate) : "-"}</td>
                <td>{movement.note || "-"}</td>
              </tr>)}
            </tbody>
          </table>
          <div className="pagination-row">
            <span>{filteredViewingMovements.length} movimentacao(oes)</span>
            <div>
              <button className="secondary" type="button" disabled={stockMovementCurrentPage <= 1} onClick={() => setStockMovementPage(stockMovementCurrentPage - 1)}>Anterior</button>
              <strong>{stockMovementCurrentPage} / {stockMovementTotalPages}</strong>
              <button className="secondary" type="button" disabled={stockMovementCurrentPage >= stockMovementTotalPages} onClick={() => setStockMovementPage(stockMovementCurrentPage + 1)}>Proxima</button>
            </div>
          </div>
        </div>
      </div>
    </div>}
    <div className="card product-filter-card">
      <h2>Filtros</h2>
      <div className="filters-grid stock-filters">
        <label>Produto<input value={draftFilters.name} onChange={(event) => setDraftFilters({ ...draftFilters, name: uppercaseInput(event.target.value) })} placeholder="Buscar produto" /></label>
        <label>Categoria<select value={draftFilters.categoryId} onChange={(event) => setDraftFilters({ ...draftFilters, categoryId: event.target.value })}>
          <option value="">Todas</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select></label>
        <label>Marca<input value={draftFilters.brand} onChange={(event) => setDraftFilters({ ...draftFilters, brand: uppercaseInput(event.target.value) })} placeholder="Buscar marca" /></label>
        <div className="filter-actions">
          <button className="primary" type="button" onClick={() => setFilters(draftFilters)}>Buscar</button>
          <button className="secondary" type="button" onClick={clearFilters}>Limpar filtros</button>
        </div>
      </div>
    </div>
    <div className="card table-wrap stock-table-card">
      <h2>Produtos</h2>
      <table>
        <thead><tr><th>Imagem</th><th>Produto</th><th>Categoria</th><th>Marca</th><th>Quantidade</th><th>Situacao do estoque</th><th>Acoes</th></tr></thead>
        <tbody>
          {filteredProducts.length === 0 && <tr><td colSpan={7}>Nenhum produto encontrado.</td></tr>}
          {filteredProducts.map((product) => {
            const situation = stockSituation(product);
            return <tr key={product.id}>
              <td><ProductImage product={product} /></td>
              <td>{product.name}</td>
              <td>{product.category?.name ?? "-"}</td>
              <td>{product.brand || "-"}</td>
              <td><strong>{product.stock}</strong></td>
              <td><span className={`stock-badge ${situation.className}`}>{situation.label}</span></td>
              <td><div className="action-row">
                <button className="icon-btn action-icon action-view" title="Visualizar produto" type="button" onClick={() => openStockDetails(product)}><Eye size={16} /></button>
                {can("stock.move") && <button className="icon-btn action-icon action-stock" title="Movimentar estoque" type="button" onClick={() => openStockMovement(product)}><PackagePlus size={16} /></button>}
              </div></td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  </section>;
}

function Finance({ entries, products, orders, onSaved, notify, can }: { entries: FinanceEntry[]; products: Product[]; orders: Order[]; onSaved: () => void; notify: Notify; can: (permission: string) => boolean }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [amount, setAmount] = useState(0);
  const [saving, setSaving] = useState(false);
  const stockInvested = products.reduce((sum, product) => sum + Number(product.costPrice) * product.stock, 0);
  const salesReceived = orders.reduce((sum, order) => sum + Number(order.amountPaid ?? 0), 0);
  const manualIncome = entries.filter((entry) => entry.type === "income" && !textMatches(entry.description, "venda")).reduce((sum, entry) => sum + Number(entry.amount), 0);
  const cashWithdrawals = entries.filter((entry) => entry.type === "expense").reduce((sum, entry) => sum + Number(entry.amount), 0);
  const cashReceived = salesReceived + manualIncome - cashWithdrawals;
  const totalPages = Math.max(1, Math.ceil(entries.length / 10));
  const currentPage = Math.min(page, totalPages);
  const paginatedEntries = entries.slice((currentPage - 1) * 10, currentPage * 10);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSaving(true);
    try {
      await api.createFinance({
        type: form.get("type") === "expense" ? "expense" : "income",
        description: uppercaseInput(String(form.get("description"))),
        amount: parseMoneyInput(form.get("amount")),
        category: form.get("type") === "expense" ? "Retirada de caixa" : "Entrada em caixa"
      });
      formElement.reset();
      setAmount(0);
      setModalOpen(false);
      setPage(1);
      await onSaved();
      notify("success", "Lancamento financeiro salvo com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel salvar o lancamento financeiro.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="stack finance-page">
    <div className="finance-summary">
      <div className="metric metric-orange finance-highlight">Investido em estoque<strong>{brl(stockInvested)}</strong></div>
      <div className="metric metric-green finance-highlight">Caixa recebido<strong>{brl(cashReceived)}</strong></div>
      <div className="metric metric-blue">Recebido em vendas<strong>{brl(salesReceived)}</strong></div>
      <div className="metric metric-red">Retiradas de caixa<strong>{brl(cashWithdrawals)}</strong></div>
    </div>
    {modalOpen && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="card-title-row">
          <h2>Lancamento financeiro</h2>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => { setModalOpen(false); setAmount(0); }}><X size={16} /></button>
        </div>
        <form className="form" onSubmit={submit}>
          <label>Tipo<select name="type"><option value="income">Entrada em caixa</option><option value="expense">Retirada de caixa</option></select></label>
          <label>Descricao<input name="description" required onChange={(event) => { event.currentTarget.value = uppercaseInput(event.currentTarget.value); }} /></label>
          <label>Valor<input name="amount" type="text" inputMode="numeric" required value={amount ? formatMoneyInput(amount) : ""} onChange={(event) => { maskMoneyInput(event.currentTarget); setAmount(parseMoneyInput(event.currentTarget.value)); }} /></label>
          <button className="primary" type="submit" disabled={saving}><DollarSign size={18} />{saving ? "Salvando..." : "Salvar lancamento"}</button>
        </form>
      </div>
    </div>}
    <div className="card table-wrap">
      <div className="section-heading">
        <div>
          <h2>Movimentacoes</h2>
          <p className="muted">Ultimas movimentacoes financeiras registradas.</p>
        </div>
        {can("finance.create") && <button className="primary" type="button" onClick={() => setModalOpen(true)}><DollarSign size={18} />Novo lancamento</button>}
      </div>
      <table>
        <thead><tr><th>Tipo</th><th>Descricao</th><th>Valor</th><th>Data</th></tr></thead>
        <tbody>
          {paginatedEntries.length === 0 && <tr><td colSpan={4}>Nenhuma movimentacao registrada.</td></tr>}
          {paginatedEntries.map((entry) => <tr key={entry.id}>
            <td><span className={`badge ${entry.type === "expense" ? "badge-error" : ""}`}>{financeLabel(entry.type)}</span></td>
            <td>{entry.description}</td>
            <td className={entry.type === "expense" ? "danger" : "success"}>{entry.type === "expense" ? "- " : "+ "}{brl(entry.amount)}</td>
            <td>{new Date(entry.createdAt).toLocaleDateString("pt-BR")}</td>
          </tr>)}
        </tbody>
      </table>
      <div className="pagination-row">
        <span>{entries.length} movimentacao(oes)</span>
        <div>
          <button className="secondary" type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Anterior</button>
          <strong>{currentPage} / {totalPages}</strong>
          <button className="secondary" type="button" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>Proxima</button>
        </div>
      </div>
    </div>
  </section>;
}

function Orders({ products, orders, customers, onSaved, notify, can }: { products: Product[]; orders: Order[]; customers: Customer[]; onSaved: () => void; notify: Notify; can: (permission: string) => boolean }) {
  const [saleView, setSaleView] = useState<"create" | "sales" | "credit">("create");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [draftCart, setDraftCart] = useState<Record<string, number>>({});
  const [saleType, setSaleType] = useState<"avulso" | "cliente">("avulso");
  const [customerQuery, setCustomerQuery] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [customerFormOpen, setCustomerFormOpen] = useState(false);
  const [customerDraft, setCustomerDraft] = useState({ name: "", phone: "", cpf: "" });
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("pix");
  const [amountPaid, setAmountPaid] = useState(0);
  const [advanceFiado, setAdvanceFiado] = useState(false);
  const [cashReceived, setCashReceived] = useState(0);
  const [needsChange, setNeedsChange] = useState(false);
  const [savingSale, setSavingSale] = useState(false);
  const [productQuery, setProductQuery] = useState("");
  const [cartOpen, setCartOpen] = useState(false);
  const selectedItems = products
    .filter((product) => (cart[product.id] ?? 0) > 0)
    .map((product) => ({ product, quantity: cart[product.id] ?? 0, subtotal: saleTotalFromLots(product, cart[product.id] ?? 0) }));
  const total = selectedItems.reduce((sum, item) => sum + item.subtotal, 0);
  const normalizedQuery = customerQuery.replace(/\D/g, "");
  const customerSuggestions = customers
    .filter((customer) => {
      if (customerQuery.trim().length < 2 || selectedCustomer) return false;
      return textMatches(customer.name, customerQuery)
        || (normalizedQuery.length > 0 && (customer.phone ?? "").replace(/\D/g, "").includes(normalizedQuery))
        || (normalizedQuery.length > 0 && (customer.cpf ?? "").replace(/\D/g, "").includes(normalizedQuery));
    })
    .slice(0, 6);
  const payableTotal = total;
  const effectiveAmountPaid = paymentMethod === "fiado" ? (advanceFiado ? Math.min(amountPaid, payableTotal) : 0) : paymentMethod === "dinheiro" ? payableTotal : payableTotal;
  const amountDue = Math.max(payableTotal - effectiveAmountPaid, 0);
  const cashChange = paymentMethod === "dinheiro" && needsChange ? Math.max(cashReceived - payableTotal, 0) : 0;
  const cashInsufficient = paymentMethod === "dinheiro" && needsChange && cashReceived < payableTotal;
  const selectedCustomerDebt = selectedCustomer
    ? orders.filter((order) => order.customerId === selectedCustomer.id).reduce((sum, order) => sum + Number(order.amountDue ?? 0), 0)
    : 0;
  const creditLimit = Number(selectedCustomer?.creditLimit ?? 10);
  const creditAvailable = Math.max(creditLimit - selectedCustomerDebt, 0);
  const creditAvailableAfterSale = Math.max(creditAvailable - (paymentMethod === "fiado" ? amountDue : 0), 0);
  const creditExceeded = paymentMethod === "fiado" && saleType === "cliente" && selectedCustomer && amountDue > creditAvailable;
  const fiadoWithoutCustomer = paymentMethod === "fiado" && saleType !== "cliente";
  const hasInvalidStock = selectedItems.some((item) => item.quantity > item.product.stock || item.product.stock <= 0);
  const saleBlocked = savingSale || total <= 0 || hasInvalidStock || fiadoWithoutCustomer || Boolean(creditExceeded) || cashInsufficient;
  const activeProducts = products.filter((p) => p.active && textMatches(p.name, productQuery));

  function updateDraftCart(product: Product, quantity: number) {
    const safeQuantity = Math.max(0, Math.min(quantity, product.stock));
    setDraftCart((current) => ({ ...current, [product.id]: safeQuantity }));
  }

  function addProductToCart(product: Product) {
    const quantity = draftCart[product.id] ?? 0;
    if (quantity <= 0) return;
    setCart((current) => ({ ...current, [product.id]: Math.min((current[product.id] ?? 0) + quantity, product.stock) }));
    setDraftCart((current) => ({ ...current, [product.id]: 0 }));
  }

  function updateCartItem(product: Product, quantity: number) {
    const safeQuantity = Math.max(0, Math.min(quantity, product.stock));
    setCart((current) => {
      const next = { ...current };
      if (safeQuantity <= 0) delete next[product.id];
      else next[product.id] = safeQuantity;
      return next;
    });
  }

  function removeCartItem(productId: string) {
    setCart((current) => {
      const next = { ...current };
      delete next[productId];
      return next;
    });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingSale || saleBlocked) return;
    const form = new FormData(event.currentTarget);
    setSavingSale(true);
    try {
      await api.createOrder({
        saleType,
        customerId: selectedCustomer?.id,
        customerName: saleType === "cliente" ? uppercaseInput(String(form.get("customerName"))) : "AVULSO",
        customerPhone: saleType === "cliente" ? String(form.get("customerPhone")) : "",
        customerCpf: saleType === "cliente" ? String(form.get("customerCpf")) : "",
        paymentMethod,
        amountPaid: effectiveAmountPaid,
        useCashback: false,
        items: Object.entries(cart).filter(([, quantity]) => quantity > 0).map(([productId, quantity]) => ({ productId, quantity }))
      });
      setCart({});
      setDraftCart({});
      setSelectedCustomer(null);
      setCustomerQuery("");
      setCustomerFormOpen(false);
      setCustomerDraft({ name: "", phone: "", cpf: "" });
      setAmountPaid(0);
      setAdvanceFiado(false);
      setCashReceived(0);
      setNeedsChange(false);
      setCartOpen(false);
      await onSaved();
      notify("success", "Venda registrada com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel registrar a venda.");
    } finally {
      setSavingSale(false);
    }
  }

  async function createSaleCustomer() {
    if (savingCustomer) return;
    const name = uppercaseInput(customerDraft.name.trim() || customerQuery.trim());
    if (!name) {
      notify("error", "Informe o nome do cliente.");
      return;
    }
    setSavingCustomer(true);
    try {
      const created = await api.createCustomer({
        name,
        phone: customerDraft.phone,
        cpf: customerDraft.cpf,
        creditLimit: 10
      });
      setSelectedCustomer(created);
      setCustomerQuery(created.name);
      setCustomerFormOpen(false);
      setCustomerDraft({ name: "", phone: "", cpf: "" });
      await onSaved();
      notify("success", "Cliente cadastrado com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel cadastrar o cliente.");
    } finally {
      setSavingCustomer(false);
    }
  }

  function checkoutPanel(showCloseButton: boolean) {
    return <div className="card checkout operator-checkout modal customer-cart-drawer sales-cart-panel">
      <div className="section-heading">
        <div>
          <span className="badge">Carrinho</span>
          <h2>Fechar venda</h2>
        </div>
        {showCloseButton && <button className="icon-btn" type="button" title="Fechar" onClick={() => setCartOpen(false)}><X size={18} /></button>}
      </div>
      <form className="form" onSubmit={submit}>
      <label>Tipo de venda<select value={saleType} onChange={(event) => { const nextSaleType = event.target.value as "avulso" | "cliente"; setSaleType(nextSaleType); if (nextSaleType === "avulso" && paymentMethod === "fiado") { setPaymentMethod("pix"); setAdvanceFiado(false); setAmountPaid(0); } setSelectedCustomer(null); setCustomerQuery(""); setCustomerFormOpen(false); setCustomerDraft({ name: "", phone: "", cpf: "" }); }}>
        <option value="avulso">Avulso</option>
        <option value="cliente">Cliente cadastrado</option>
      </select></label>
      {saleType === "cliente" && <>
        <div className="customer-search-row">
          <label>Buscar cliente<input autoComplete="off" value={customerQuery} placeholder="Digite nome, telefone ou CPF" onChange={(event) => { setCustomerQuery(uppercaseInput(event.target.value)); setSelectedCustomer(null); }} /></label>
          <button className="secondary" type="button" onClick={() => { setCustomerFormOpen(true); setCustomerDraft((current) => ({ ...current, name: selectedCustomer?.name ?? customerQuery })); }}><UserRound size={16} />Cadastrar cliente</button>
        </div>
        {customerQuery.trim().length >= 2 && !selectedCustomer && customerSuggestions.length === 0 && <div className="customer-not-found">
          <strong>Cliente nao encontrado</strong>
          <span>Cadastre este cliente para vincular a venda.</span>
        </div>}
        {customerSuggestions.length > 0 && <div className="suggestions">{customerSuggestions.map((customer) => <button type="button" key={customer.id} onClick={() => { setSelectedCustomer(customer); setCustomerQuery(customer.name); setCustomerFormOpen(false); }}>{customer.name}<span>{customer.phone || customer.cpf || "sem telefone"}</span></button>)}</div>}
        <input type="hidden" name="customerName" value={selectedCustomer?.name ?? customerQuery} readOnly />
        <input type="hidden" name="customerPhone" value={selectedCustomer?.phone ?? ""} readOnly />
        <input type="hidden" name="customerCpf" value={selectedCustomer?.cpf ?? ""} readOnly />
        {selectedCustomer && <div className="customer-info-card">
          <div><span>Nome</span><strong>{selectedCustomer.name}</strong></div>
          <div><span>Telefone</span><strong>{selectedCustomer.phone || "-"}</strong></div>
          <div><span>CPF</span><strong>{selectedCustomer.cpf || "-"}</strong></div>
        </div>}
      </>}
      <label>Forma de pagamento<select value={paymentMethod} onChange={(event) => { const nextPayment = event.target.value as PaymentMethod; setPaymentMethod(nextPayment); setCashReceived(0); setNeedsChange(false); setAdvanceFiado(false); setAmountPaid(0); }}>
        <option value="dinheiro">Dinheiro</option>
        <option value="pix">Pix</option>
        <option value="cartao">Cartao</option>
        {saleType === "cliente" && <option value="fiado">Fiado</option>}
      </select></label>
      {paymentMethod === "dinheiro" && <label className="check-row"><input type="checkbox" checked={needsChange} onChange={(event) => { setNeedsChange(event.target.checked); if (!event.target.checked) setCashReceived(0); }} />Precisa de troco</label>}
      {paymentMethod === "dinheiro" && needsChange && <label>Valor recebido<input type="text" inputMode="numeric" value={cashReceived ? formatMoneyInput(cashReceived) : ""} placeholder="R$ 0,00" onChange={(event) => { maskMoneyInput(event.currentTarget); setCashReceived(parseMoneyInput(event.currentTarget.value)); }} /></label>}
      {paymentMethod === "fiado" && <label className="check-row"><input type="checkbox" checked={advanceFiado} onChange={(event) => { setAdvanceFiado(event.target.checked); if (!event.target.checked) setAmountPaid(0); }} />Adiantar algum valor?</label>}
      {paymentMethod === "fiado" && advanceFiado && <label>Valor pago agora<input type="text" inputMode="numeric" value={amountPaid ? formatMoneyInput(amountPaid) : ""} placeholder="R$ 0,00" onChange={(event) => { maskMoneyInput(event.currentTarget); setAmountPaid(parseMoneyInput(event.currentTarget.value)); }} /></label>}
      <div className="operator-cart-scroll">
        <div className="sale-summary operator-summary operator-cart-items">
          {selectedItems.length === 0 && <span className="muted">Nenhum produto selecionado.</span>}
          {selectedItems.map((item) => <div className="operator-cart-line" key={item.product.id}>
            <div>
              <span>{item.product.name}</span>
              <strong>{brl(item.subtotal)}</strong>
            </div>
            <div className="cart-line-controls">
              <button type="button" onClick={() => updateCartItem(item.product, item.quantity - 1)}>-</button>
              <input type="number" min="0" max={item.product.stock} value={item.quantity} onChange={(event) => updateCartItem(item.product, Number(event.target.value))} />
              <button type="button" onClick={() => updateCartItem(item.product, item.quantity + 1)}>+</button>
              <button className="cart-remove-button" type="button" title="Remover produto" onClick={() => removeCartItem(item.product.id)}><Trash2 size={15} /></button>
            </div>
          </div>)}
        </div>
      </div>
      <div className="operator-checkout-footer">
        {(paymentMethod === "fiado" || (paymentMethod === "dinheiro" && needsChange)) && <div className="operator-sale-extras">
          {paymentMethod === "dinheiro" && needsChange && <div><span>Valor recebido</span><strong>{brl(cashReceived)}</strong></div>}
          {paymentMethod === "dinheiro" && needsChange && <div><span>Troco</span><strong className={cashInsufficient ? "danger" : "success"}>{brl(cashChange)}</strong></div>}
          {paymentMethod === "fiado" && <div><span>Falta receber</span><strong>{brl(amountDue)}</strong></div>}
          {paymentMethod === "fiado" && saleType === "cliente" && <div><span>Limite total</span><strong>{brl(creditLimit)}</strong></div>}
          {paymentMethod === "fiado" && saleType === "cliente" && <div><span>Limite usado</span><strong>{brl(selectedCustomerDebt)}</strong></div>}
          {paymentMethod === "fiado" && saleType === "cliente" && <div><span>Disponivel apos venda</span><strong className={creditExceeded ? "danger" : "success"}>{brl(creditAvailableAfterSale)}</strong></div>}
        </div>}
        {fiadoWithoutCustomer && <div className="alert">Fiado so pode ser vendido para cliente cadastrado ou cadastrado na hora.</div>}
        {creditExceeded && <div className="alert">Limite de fiado excedido para este cliente.</div>}
        {cashInsufficient && <div className="alert">Valor recebido menor que o total da venda.</div>}
        <div className="checkout-total"><span>Total</span><strong>{brl(payableTotal)}</strong></div>
        <button className="primary" disabled={saleBlocked || savingSale} type="submit"><ShoppingCart size={18} />{savingSale ? "Registrando..." : "Registrar venda"}</button>
      </div>
    </form>
    </div>;
  }

  return <>
  <div className="sales-toolbar">
    <div className="metrics sales-view-cards">
      {can("orders.create") && <button className={`metric metric-teal ${saleView === "create" ? "metric-active" : ""}`} onClick={() => setSaleView("create")}>Cadastrar venda<strong>{selectedItems.reduce((sum, item) => sum + item.quantity, 0)}</strong></button>}
      {(can("orders.edit") || can("orders.delete")) && <button className={`metric metric-blue ${saleView === "sales" ? "metric-active" : ""}`} onClick={() => setSaleView("sales")}>Vendas<strong>{orders.length}</strong></button>}
      {can("orders.receive") && <button className={`metric metric-orange ${saleView === "credit" ? "metric-active" : ""}`} onClick={() => setSaleView("credit")}>Fiados<strong>{orders.filter((order) => Number(order.amountDue ?? 0) > 0 || order.paymentStatus === "partial" || order.paymentStatus === "pending").length}</strong></button>}
    </div>
    {saleView === "create" && can("orders.create") && <button className="cart-button operator-cart-button" type="button" onClick={() => setCartOpen(true)}><ShoppingCart size={18} />Carrinho<span>{selectedItems.reduce((sum, item) => sum + item.quantity, 0)}</span></button>}
  </div>
  {saleView === "create" && can("orders.create") && <section className="sales-workspace">
    <div className="sales-products-panel">
      <div className="card product-filter-card">
        <h2>Buscar produto</h2>
        <div className="filters-grid product-filters">
          <label>Produto<input value={productQuery} onChange={(event) => setProductQuery(uppercaseInput(event.target.value))} placeholder="Digite o nome do produto" /></label>
          <div className="filter-actions">
            <button className="secondary" type="button" onClick={() => setProductQuery("")}>Limpar</button>
          </div>
        </div>
      </div>
      <div className="catalog sales-catalog">{activeProducts.map((product, index) => {
        const quantity = draftCart[product.id] ?? 0;
        const cartQuantity = cart[product.id] ?? 0;
        return <div className={`card product-card operator-product-card ${product.stock <= 0 ? "disabled-card" : ""} ${cartQuantity > 0 ? "selected-card" : ""}`} key={product.id}>
          <div className={`product-accent accent-${index % 5}`} />
          <ProductImage product={product} />
          <div className="product-card-body">
            <strong>{product.name}</strong>
            <span className="muted">{brl(nextSalePrice(product))} - estoque {product.stock}</span>
            <div className="product-card-row">
              {product.stock <= 0 && <span className="stock-badge stock-out">Sem estoque</span>}
              {product.stock > 0 && product.stock < 10 && <span className="stock-badge stock-low">Estoque baixo</span>}
              {cartQuantity > 0 && <span className="stock-badge stock-ok">No carrinho: {cartQuantity}</span>}
            </div>
          </div>
          {product.stock > 0 && <div className="qty-stepper">
            <button type="button" onClick={() => updateDraftCart(product, quantity - 1)}>-</button>
            <input type="number" min="0" max={product.stock} value={quantity} onChange={(e) => updateDraftCart(product, Number(e.target.value))} />
            <button type="button" onClick={() => updateDraftCart(product, quantity + 1)}>+</button>
          </div>}
          {product.stock > 0 && <button className="add-cart-button operator-add-cart-button" type="button" disabled={(draftCart[product.id] ?? 0) <= 0} onClick={() => addProductToCart(product)}>
            <ShoppingCart size={16} />Adicionar ao carrinho
          </button>}
        </div>;
      })}</div>
    </div>
    <aside className="sales-cart-sidebar">{checkoutPanel(false)}</aside>
    {cartOpen && <div className="modal-backdrop customer-cart-backdrop mobile-cart-modal" role="dialog" aria-modal="true">
      {checkoutPanel(true)}
    </div>}
    {customerFormOpen && !selectedCustomer && <div className="modal-backdrop modal-backdrop-front" role="dialog" aria-modal="true">
      <div className="modal customer-create-modal">
        <div className="card-title-row">
          <div>
            <span className="badge">Cliente</span>
            <h2>Cadastrar cliente</h2>
          </div>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => setCustomerFormOpen(false)}><X size={16} /></button>
        </div>
        <div className="form">
          <label>Nome<input autoFocus value={customerDraft.name} required onChange={(event) => setCustomerDraft((current) => ({ ...current, name: uppercaseInput(event.target.value) }))} /></label>
          <label>Telefone<input value={customerDraft.phone} inputMode="tel" placeholder="(11) 99999-9999" onChange={(event) => setCustomerDraft((current) => ({ ...current, phone: phoneMask(event.target.value) }))} /></label>
          <label>CPF<input value={customerDraft.cpf} onChange={(event) => setCustomerDraft((current) => ({ ...current, cpf: event.target.value }))} /></label>
          <button className="primary" type="button" disabled={savingCustomer} onClick={createSaleCustomer}><UserRound size={16} />{savingCustomer ? "Salvando..." : "Salvar cliente"}</button>
        </div>
      </div>
    </div>}
  </section>}
  {saleView === "sales" && (can("orders.edit") || can("orders.delete")) && <SalesAdmin orders={orders} onSaved={onSaved} notify={notify} can={can} />}
  {saleView === "credit" && can("orders.receive") && <PendingSales orders={orders} onSaved={onSaved} notify={notify} />}
  </>;
}

function paymentLabel(paymentMethod?: string) {
  const labels: Record<string, string> = {
    dinheiro: "Dinheiro",
    pix: "Pix",
    cartao: "Cartao",
    credito_local: "Fiado",
    fiado: "Fiado"
  };
  return labels[paymentMethod ?? ""] ?? "Nao informado";
}

function PendingSales({ orders, onSaved, notify }: { orders: Order[]; onSaved: () => void; notify: Notify }) {
  const [receiving, setReceiving] = useState<{ customerName: string; total: number; amountPaid: number; amountDue: number; orders: Order[] } | null>(null);
  const [viewingOrder, setViewingOrder] = useState<Order | null>(null);
  const [amount, setAmount] = useState(0);
  const [clientFilter, setClientFilter] = useState("");
  const [expandedClients, setExpandedClients] = useState<Record<string, boolean>>({});
  const [savingPayment, setSavingPayment] = useState(false);
  const pending = orders.filter((order) => {
    const isPending = Number(order.amountDue ?? 0) > 0 || order.paymentStatus === "partial" || order.paymentStatus === "pending";
    const clientMatches = textMatches(order.customerName || "AVULSO", clientFilter);
    return isPending && clientMatches;
  });
  const pendingGroups = pending.reduce<Array<{ key: string; customerName: string; total: number; amountPaid: number; amountDue: number; orders: Order[] }>>((groups, order) => {
    const key = order.customerId || normalizeText(order.customerName || "AVULSO");
    const group = groups.find((item) => item.key === key);
    if (group) {
      group.total += Number(order.total ?? 0);
      group.amountPaid += Number(order.amountPaid ?? 0);
      group.amountDue += Number(order.amountDue ?? 0);
      group.orders.push(order);
      return groups;
    }
    groups.push({
      key,
      customerName: order.customerName || "Avulso",
      total: Number(order.total ?? 0),
      amountPaid: Number(order.amountPaid ?? 0),
      amountDue: Number(order.amountDue ?? 0),
      orders: [order]
    });
    return groups;
  }, []).sort((a, b) => a.customerName.localeCompare(b.customerName));

  function startReceive(group: { customerName: string; total: number; amountPaid: number; amountDue: number; orders: Order[] }) {
    setReceiving(group);
    setAmount(Number(group.amountDue ?? 0));
  }

  async function pay() {
    if (!receiving) return;
    if (amount <= 0) return;
    if (savingPayment) return;
    setSavingPayment(true);
    try {
      let remaining = amount;
      const payableOrders = receiving.orders
        .filter((order) => Number(order.amountDue ?? 0) > 0)
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const order of payableOrders) {
        if (remaining <= 0) break;
        const payment = Math.min(remaining, Number(order.amountDue ?? 0));
        if (payment > 0) await api.addOrderPayment(order.id, payment);
        remaining = Number((remaining - payment).toFixed(2));
      }
      setReceiving(null);
      setAmount(0);
      await onSaved();
      notify("success", "Recebimento registrado com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel registrar o recebimento.");
    } finally {
      setSavingPayment(false);
    }
  }

  return <div className="card table-wrap full-row">
    <h2>Fiado e pagamentos pendentes</h2>
    <div className="inline-filter">
      <label>Buscar cliente<input value={clientFilter} onChange={(event) => setClientFilter(uppercaseInput(event.target.value))} placeholder="Digite o nome do cliente" /></label>
      <button className="secondary" type="button" onClick={() => setClientFilter("")}>Limpar</button>
    </div>
    {receiving && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="card-title-row">
          <h2>Registrar pagamento</h2>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => setReceiving(null)}><X size={16} /></button>
        </div>
        <div className="form">
          <label>Cliente<input value={receiving.customerName || "Avulso"} disabled /></label>
          <div className="sale-summary">
            <div><span>Total</span><strong>{brl(receiving.total)}</strong></div>
            <div><span>Ja pago</span><strong>{brl(receiving.amountPaid ?? 0)}</strong></div>
            <div><span>Falta</span><strong className="danger">{brl(receiving.amountDue ?? 0)}</strong></div>
          </div>
          <label>Valor recebido<input autoFocus type="text" inputMode="numeric" value={formatMoneyInput(amount)} onChange={(event) => { maskMoneyInput(event.currentTarget); setAmount(parseMoneyInput(event.currentTarget.value)); }} /></label>
          <button className="primary" type="button" disabled={savingPayment || amount <= 0} onClick={pay}>{savingPayment ? "Salvando..." : "Registrar pagamento"}</button>
        </div>
      </div>
    </div>}
    {viewingOrder && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <div className="card-title-row">
          <div>
            <span className="badge">Compra fiada</span>
            <h2>{viewingOrder.customerName || "Avulso"}</h2>
          </div>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => setViewingOrder(null)}><X size={16} /></button>
        </div>
        <div className="order-modal-summary">
          <div className="order-summary-row"><span>Data</span><strong>{dateLabel(viewingOrder.createdAt)}</strong></div>
          <div className="order-summary-row"><span>Forma de pagamento</span><strong>{paymentLabel(viewingOrder.paymentMethod)}</strong></div>
          <div className="order-summary-row"><span>Total</span><strong>{brl(viewingOrder.total)}</strong></div>
          <div className="order-summary-row"><span>Pago</span><strong>{brl(viewingOrder.amountPaid ?? 0)}</strong></div>
          <div className="order-summary-row"><span>Falta</span><strong className="danger">{brl(viewingOrder.amountDue ?? 0)}</strong></div>
          <div className="order-summary-row"><span>Telefone</span><strong>{viewingOrder.customerPhone || "-"}</strong></div>
        </div>
        <div className="order-items-modal">
          {viewingOrder.items.map((item, index) => <div className="order-item-card" key={`${item.productId}-${item.lotCode ?? "sem-lote"}-${index}`}>
            <div className="order-item-image">
              {item.product?.imageUrl ? <img src={assetUrl(item.product.imageUrl)} alt={item.product.name} /> : <Boxes size={24} />}
            </div>
            <div>
              <strong>{item.product?.name ?? "Produto"}</strong>
              <span>{item.quantity} unidade(s) x {brl(item.unitPrice)}</span>
              {item.lotCode && <span className="muted">Lote: {item.lotCode}</span>}
            </div>
            <strong>{brl(Number(item.unitPrice) * item.quantity)}</strong>
          </div>)}
        </div>
      </div>
    </div>}
    <table>
      <thead><tr><th>Cliente</th><th>Compras</th><th>Total</th><th>Pago</th><th>Falta</th><th>Acoes</th></tr></thead>
      <tbody>
        {pendingGroups.length === 0 && <tr><td colSpan={6}>Nenhuma venda pendente.</td></tr>}
        {pendingGroups.map((group) => <React.Fragment key={group.key}>
          <tr key={group.key}>
            <td>
              <button className="icon-btn inline-expand-button" type="button" title={expandedClients[group.key] ? "Ocultar compras" : "Mostrar compras"} onClick={() => setExpandedClients((current) => ({ ...current, [group.key]: !current[group.key] }))}>
                <ChevronDown size={16} className={expandedClients[group.key] ? "rotated-icon" : ""} />
              </button>
              {group.customerName}
            </td>
            <td>{group.orders.length}</td>
            <td>{brl(group.total)}</td>
            <td>{brl(group.amountPaid)}</td>
            <td className="danger">{brl(group.amountDue)}</td>
            <td><button className="secondary" onClick={() => startReceive(group)}>Registrar pagamento</button></td>
          </tr>
          {expandedClients[group.key] && group.orders
            .slice()
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((order) => <tr className="expanded-detail-row" key={order.id}>
              <td><span className="muted">{dateLabel(order.createdAt)}</span></td>
              <td>{paymentLabel(order.paymentMethod)}</td>
              <td>{brl(order.total)}</td>
              <td>{brl(order.amountPaid ?? 0)}</td>
              <td className="danger">{brl(order.amountDue ?? 0)}</td>
              <td><button className="icon-btn action-icon action-view" type="button" title="Ver detalhes da compra" aria-label={`Ver detalhes da compra de ${order.customerName || "Avulso"}`} onClick={() => setViewingOrder(order)}><Eye size={16} /></button></td>
            </tr>)}
        </React.Fragment>)}
      </tbody>
    </table>
  </div>;
}

function SalesAdmin({ orders, onSaved, notify, can }: { orders: Order[]; onSaved: () => void; notify: Notify; can: (permission: string) => boolean }) {
  const [editing, setEditing] = useState<Order | null>(null);
  const [removing, setRemoving] = useState<Order | null>(null);
  const [clientFilter, setClientFilter] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("pix");
  const [paymentStatus, setPaymentStatus] = useState<"paid" | "partial" | "pending">("paid");
  const [amountPaid, setAmountPaid] = useState(0);
  const [removalKey, setRemovalKey] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [removingSale, setRemovingSale] = useState(false);

  function startEdit(order: Order) {
    setEditing(order);
    setPaymentMethod(order.paymentMethod ?? "pix");
    setPaymentStatus(order.paymentStatus ?? "paid");
    setAmountPaid(Number(order.amountPaid ?? 0));
    setRemovalKey("");
  }

  async function saveEdit() {
    if (!editing) return;
    if (savingEdit) return;
    setSavingEdit(true);
    try {
      await api.updateOrderPayment(editing.id, { paymentMethod, paymentStatus, amountPaid });
      setEditing(null);
      await onSaved();
      notify("success", "Venda atualizada com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel atualizar a venda.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function removeSale() {
    if (!removing || !removalKey) return;
    if (removingSale) return;
    setRemovingSale(true);
    try {
      await api.deleteOrder(removing.id, removalKey);
      setRemoving(null);
      setRemovalKey("");
      await onSaved();
      notify("success", "Venda excluida com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel excluir a venda.");
    } finally {
      setRemovingSale(false);
    }
  }

  const filteredOrders = orders.filter((order) => textMatches(order.customerName || "AVULSO", clientFilter));

  return <div className="card table-wrap full-row">
    <h2>Administrar vendas</h2>
    <div className="inline-filter">
      <label>Buscar cliente<input value={clientFilter} onChange={(event) => setClientFilter(uppercaseInput(event.target.value))} placeholder="Digite o nome do cliente" /></label>
      <button className="secondary" type="button" onClick={() => setClientFilter("")}>Limpar</button>
    </div>
    {editing && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <div className="card-title-row">
          <h2>Editar venda</h2>
          <button className="icon-btn" type="button" title="Fechar edicao" onClick={() => setEditing(null)}><X size={16} /></button>
        </div>
        <div className="form two">
          <label>Cliente<input value={editing.customerName || "Avulso"} disabled /></label>
          <label>Total<input value={brl(editing.total)} disabled /></label>
          <label>Pagamento<select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)}>
            <option value="dinheiro">Dinheiro</option>
            <option value="pix">Pix</option>
            <option value="cartao">Cartao</option>
            <option value="fiado">Fiado</option>
          </select></label>
          <label>Status<select value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value as "paid" | "partial" | "pending")}>
            <option value="paid">Pago</option>
            <option value="partial">Pago parcialmente</option>
            <option value="pending">Nao pago</option>
          </select></label>
          <label>Valor pago<input type="number" min="0" max={Number(editing.total)} step="0.01" value={amountPaid} onChange={(event) => setAmountPaid(Number(event.target.value))} /></label>
          <label>Falta<input value={brl(Math.max(Number(editing.total) - amountPaid, 0))} disabled /></label>
          <button className="primary" type="button" disabled={savingEdit} onClick={saveEdit}>{savingEdit ? "Salvando..." : "Salvar alteracoes"}</button>
        </div>
      </div>
    </div>}
    {removing && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="card-title-row">
          <h2>Remover venda</h2>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => { setRemoving(null); setRemovalKey(""); }}><X size={16} /></button>
        </div>
        <div className="form">
          <div className="sale-summary">
            <div><span>Cliente</span><strong>{removing.customerName || "Avulso"}</strong></div>
            <div><span>Total</span><strong>{brl(removing.total)}</strong></div>
          </div>
          <label>Chave de remocao<input autoFocus type="password" value={removalKey} onChange={(event) => setRemovalKey(event.target.value)} /></label>
          <button className="primary danger-primary" type="button" disabled={removingSale || !removalKey} onClick={removeSale}>{removingSale ? "Removendo..." : "Remover venda"}</button>
        </div>
      </div>
    </div>}
    <table>
      <thead><tr><th>Data</th><th>Cliente</th><th>Tipo</th><th>Pagamento</th><th>Status</th><th>Total</th><th>Pago</th><th>Falta</th><th>Acoes</th></tr></thead>
      <tbody>
        {filteredOrders.length === 0 && <tr><td colSpan={9}>Nenhuma venda registrada.</td></tr>}
        {filteredOrders.map((order) => <tr key={order.id}>
          <td>{new Date(order.createdAt).toLocaleDateString("pt-BR")}</td>
          <td>{order.customerName || "Avulso"}</td>
          <td>{order.saleType === "cliente" ? "Cliente" : "Avulso"}</td>
          <td>{paymentLabel(order.paymentMethod)}</td>
          <td><span className="badge">{paymentStatusLabel(order)}</span></td>
          <td>{brl(order.total)}</td>
          <td>{brl(order.amountPaid ?? 0)}</td>
          <td className={(order.amountDue ?? 0) > 0 ? "danger" : "success"}>{brl(order.amountDue ?? 0)}</td>
          <td><div className="action-row">
            {can("orders.edit") && <button className="icon-btn action-icon action-edit" title="Editar venda" aria-label={`Editar venda de ${order.customerName || "Avulso"}`} onClick={() => startEdit(order)}><Edit3 size={16} /></button>}
            {can("orders.delete") && <button className="icon-btn action-icon action-remove" title="Remover venda" aria-label={`Remover venda de ${order.customerName || "Avulso"}`} onClick={() => { setRemoving(order); setRemovalKey(""); }}><X size={16} /></button>}
          </div></td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}

function Customers({ customers, orders, onSaved, notify, can, isAdmin }: { customers: Customer[]; orders: Order[]; onSaved: () => void; notify: Notify; can: (permission: string) => boolean; isAdmin: boolean }) {
  const [editing, setEditing] = useState<Customer | null>(null);
  const [viewing, setViewing] = useState<Customer | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [clientFilter, setClientFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState("");
  const formKey = editing?.id ?? "new-customer";
  const normalizedClientFilter = clientFilter.replace(/\D/g, "");
  const filteredCustomers = customers.filter((customer) => {
    return textMatches(customer.name, clientFilter)
      || (normalizedClientFilter.length > 0 && (customer.phone ?? "").replace(/\D/g, "").includes(normalizedClientFilter))
      || (normalizedClientFilter.length > 0 && (customer.cpf ?? "").replace(/\D/g, "").includes(normalizedClientFilter));
  });

  function customerCredit(customer: Customer) {
    const limit = Number(customer.creditLimit ?? 10);
    const spent = orders
      .filter((order) => order.customerId === customer.id && Number(order.amountDue ?? 0) > 0)
      .reduce((sum, order) => sum + Number(order.amountDue ?? 0), 0);
    const available = Math.max(limit - spent, 0);
    const percent = limit > 0 ? Math.min((spent / limit) * 100, 100) : 100;
    return { limit, spent, available, percent };
  }

  function openNew() {
    setEditing(null);
    setModalOpen(true);
  }

  function openEdit(customer: Customer) {
    setEditing(customer);
    setModalOpen(true);
  }

  function closeForm() {
    setEditing(null);
    setModalOpen(false);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const formElement = event.currentTarget;
    const payload = Object.fromEntries(new FormData(formElement));
    payload.name = uppercaseInput(String(payload.name ?? ""));
    payload.email = uppercaseInput(String(payload.email ?? ""));
    payload.address = uppercaseInput(String(payload.address ?? ""));
    payload.notes = uppercaseInput(String(payload.notes ?? ""));
    setSaving(true);
    try {
      if (editing) {
        await api.updateCustomer(editing.id, payload);
      } else {
        await api.createCustomer(payload);
      }
      formElement.reset();
      closeForm();
      await onSaved();
      notify("success", editing ? "Cliente atualizado com sucesso." : "Cliente cadastrado com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel salvar o cliente.");
    } finally {
      setSaving(false);
    }
  }

  async function removeCustomer(customer: Customer) {
    if (removingId) return;
    if (!window.confirm(`Excluir o cadastro de "${customer.name}"? As vendas antigas serao mantidas no historico.`)) return;
    setRemovingId(customer.id);
    try {
      await api.deleteCustomer(customer.id);
      if (viewing?.id === customer.id) setViewing(null);
      if (editing?.id === customer.id) closeForm();
      await onSaved();
      notify("success", "Cliente excluido com sucesso.");
    } catch (error) {
      notify("error", error instanceof Error ? error.message : "Nao foi possivel excluir o cliente.");
    } finally {
      setRemovingId("");
    }
  }

  const viewedCredit = viewing ? customerCredit(viewing) : null;

  return <section className="stack">
    <div className="card product-filter-card">
      <div className="section-heading">
        <h2>Buscar cliente</h2>
        {can("customers.create") && <button className="primary" type="button" onClick={openNew}><UserRound size={18} />Novo cliente</button>}
      </div>
      <div className="filters-grid product-filters">
        <label>Cliente<input value={clientFilter} onChange={(event) => setClientFilter(uppercaseInput(event.target.value))} placeholder="Nome, telefone ou CPF" /></label>
        <div className="filter-actions">
          <button className="secondary" type="button" onClick={() => setClientFilter("")}>Limpar</button>
        </div>
      </div>
    </div>
    {modalOpen && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <div className="card-title-row">
          <h2>{editing ? "Editar cliente" : "Novo cliente"}</h2>
          <button className="icon-btn" type="button" title="Fechar" onClick={closeForm}><X size={16} /></button>
        </div>
        <form key={formKey} className="form two" onSubmit={submit}>
          <label>Nome<input name="name" defaultValue={editing?.name ?? ""} onChange={(event) => { event.currentTarget.value = uppercaseInput(event.currentTarget.value); }} required /></label>
          <label>Telefone<input name="phone" defaultValue={editing?.phone ?? ""} inputMode="tel" placeholder="(11) 99999-9999" onChange={(event) => { event.currentTarget.value = phoneMask(event.currentTarget.value); }} /></label>
          <label>CPF<input name="cpf" defaultValue={editing?.cpf ?? ""} /></label>
          <label>Email<input name="email" type="email" defaultValue={editing?.email ?? ""} onChange={(event) => { event.currentTarget.value = uppercaseInput(event.currentTarget.value); }} /></label>
          <label>Limite fiado<input name="creditLimit" type="number" step="0.01" min="0" defaultValue={editing?.creditLimit ?? 10} /></label>
          <label style={{ gridColumn: "1 / -1" }}>Endereco<input name="address" defaultValue={editing?.address ?? ""} onChange={(event) => { event.currentTarget.value = uppercaseInput(event.currentTarget.value); }} /></label>
          <label style={{ gridColumn: "1 / -1" }}>Observacoes<textarea name="notes" defaultValue={editing?.notes ?? ""} onChange={(event) => { event.currentTarget.value = uppercaseInput(event.currentTarget.value); }} /></label>
          <button className="primary" type="submit" disabled={saving}><UserRound size={18} />{saving ? "Salvando..." : "Salvar cliente"}</button>
        </form>
      </div>
    </div>}
    {viewing && viewedCredit && <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-wide">
        <div className="card-title-row">
          <h2>Dados do cliente</h2>
          <button className="icon-btn" type="button" title="Fechar" onClick={() => setViewing(null)}><X size={16} /></button>
        </div>
        <div className="client-detail">
          <div>
            <span className="muted">Nome</span>
            <strong>{viewing.name}</strong>
          </div>
          <div>
            <span className="muted">Telefone</span>
            <strong>{viewing.phone || "-"}</strong>
          </div>
          <div>
            <span className="muted">CPF</span>
            <strong>{viewing.cpf || "-"}</strong>
          </div>
          <div>
            <span className="muted">Email</span>
            <strong>{viewing.email || "-"}</strong>
          </div>
          <div className="full-row">
            <span className="muted">Endereco</span>
            <strong>{viewing.address || "-"}</strong>
          </div>
          <div className="full-row">
            <span className="muted">Observacoes</span>
            <strong>{viewing.notes || "-"}</strong>
          </div>
        </div>
        <div className="credit-panel">
          <div className="metric metric-blue">Limite de fiado<strong>{brl(viewedCredit.limit)}</strong></div>
          <div className="metric metric-red">Ja usado<strong>{brl(viewedCredit.spent)}</strong></div>
          <div className="metric metric-green">Ainda pode gastar<strong>{brl(viewedCredit.available)}</strong></div>
          <div className="metric metric-orange">Cashback<strong>{brl(viewing.cashbackBalance ?? 0)}</strong></div>
        </div>
        <div className="credit-chart">
          <div className="credit-chart-top"><span>Uso do limite</span><strong>{Math.round(viewedCredit.percent)}%</strong></div>
          <div className="credit-bar"><span style={{ width: `${viewedCredit.percent}%` }} /></div>
        </div>
      </div>
    </div>}
    <div className="card table-wrap">
      <h2>Clientes</h2>
      <table>
        <thead><tr><th>Nome</th><th>Telefone</th><th>CPF</th><th>Email</th><th>Limite fiado</th><th>Usado</th><th>Disponivel</th><th>Cashback</th><th>Acoes</th></tr></thead>
        <tbody>
          {filteredCustomers.map((customer) => {
            const credit = customerCredit(customer);
            return <tr key={customer.id}>
              <td>{customer.name}</td>
              <td>{customer.phone || "-"}</td>
              <td>{customer.cpf || "-"}</td>
              <td>{customer.email || "-"}</td>
              <td>{brl(credit.limit)}</td>
              <td className={credit.spent > 0 ? "danger" : ""}>{brl(credit.spent)}</td>
              <td className={credit.available > 0 ? "success" : "danger"}>{brl(credit.available)}</td>
              <td className={(customer.cashbackBalance ?? 0) >= 1 ? "success" : ""}>{brl(customer.cashbackBalance ?? 0)}</td>
              <td><div className="action-row">
                <button className="icon-btn action-icon action-view" title="Visualizar cliente" aria-label={`Visualizar cliente ${customer.name}`} onClick={() => setViewing(customer)}><Eye size={16} /></button>
                {can("customers.edit") && <button className="icon-btn action-icon action-edit" title="Editar cliente" aria-label={`Editar cliente ${customer.name}`} onClick={() => openEdit(customer)}><Edit3 size={16} /></button>}
                {isAdmin && <button className="icon-btn action-icon action-remove" disabled={removingId === customer.id} title="Excluir cliente" aria-label={`Excluir cliente ${customer.name}`} onClick={() => removeCustomer(customer)}><Trash2 size={16} /></button>}
              </div></td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
  </section>;
}

function financeLabel(type: string) {
  const labels: Record<string, string> = {
    income: "Entrada",
    expense: "Retirada",
    receivable: "A receber"
  };
  return labels[type] ?? type;
}

function paymentStatusLabel(order: Order) {
  if ((order.amountDue ?? 0) <= 0 || order.paymentStatus === "paid") return "Pago";
  if ((order.amountPaid ?? 0) > 0 || order.paymentStatus === "partial") return "Parcial";
  return "Nao pago";
}

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
