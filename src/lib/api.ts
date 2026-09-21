export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3333";

const tokenStore = {
  get: () => localStorage.getItem("pedidos_token"),
  set: (token: string) => localStorage.setItem("pedidos_token", token),
  clear: () => localStorage.removeItem("pedidos_token")
};

export type UserRole = "admin" | "usuario" | "cliente";

export type AppUser = {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  permissions: string[];
  active: boolean;
};

export type SystemLog = {
  id: string;
  type: "login" | "error";
  level: "info" | "error";
  userId?: string;
  username?: string;
  role?: UserRole;
  action: string;
  route?: string;
  method?: string;
  message: string;
  createdAt: string;
};

export type Product = {
  id: string;
  name: string;
  sku: string;
  categoryId?: string;
  category?: ProductCategory;
  brand?: string;
  productType?: string;
  manufactureDate?: string;
  expirationDate?: string;
  lotCode?: string;
  description?: string;
  imageUrl?: string;
  costPrice: string | number;
  salePrice: string | number;
  stock: number;
  minStock: number;
  onlineAvailable?: boolean;
  active: boolean;
  lots?: ProductLot[];
};

export type ProductCategory = {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ImageSearchResult = {
  id: string;
  title: string;
  thumbnail: string;
  url: string;
  creator?: string;
  source?: string;
  license?: string;
};

export type FinanceEntry = {
  id: string;
  type: "income" | "expense" | "receivable";
  description: string;
  amount: string;
  category?: string;
  createdAt: string;
};

export type StockMovement = {
  id: string;
  productId: string;
  product?: Product;
  type: "in" | "out" | "adjustment";
  quantity: number;
  totalCost?: number;
  costPrice?: number;
  salePrice?: number;
  manufactureDate?: string;
  expirationDate?: string;
  lotCode?: string;
  note?: string;
  createdAt: string;
};

export type PaymentMethod = "dinheiro" | "pix" | "cartao" | "fiado";

export type Customer = {
  id: string;
  name: string;
  phone?: string;
  cpf?: string;
  birthday?: string;
  email?: string;
  address?: string;
  notes?: string;
  creditLimit?: number;
  cashbackBalance?: number;
  createdAt: string;
  updatedAt: string;
};

export type ProductLot = {
  id: string;
  productId: string;
  code: string;
  initialStock: number;
  currentStock: number;
  costPrice: number;
  totalCost?: number;
  salePrice: number;
  manufactureDate?: string;
  expirationDate?: string;
  createdAt: string;
};

export type Order = {
  id: string;
  saleType: "avulso" | "cliente";
  customerId?: string;
  customerName: string;
  customerPhone: string;
  paymentMethod: PaymentMethod;
  paymentStatus: "paid" | "partial" | "pending";
  source?: "admin" | "client_page";
  amountPaid: number;
  amountDue: number;
  cashbackUsed?: number;
  cashbackEarned?: number;
  cashbackReleased?: boolean;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelledByName?: string;
  total: string;
  status: string;
  whatsappUrl?: string;
  createdAt: string;
  items: Array<{ productId: string; quantity: number; unitPrice: string; costPrice?: number; lotCode?: string; product: Product }>;
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = tokenStore.get();
  const isFormData = options?.body instanceof FormData;
  const response = await fetch(`${API_URL}${path}`, {
    headers: { ...(isFormData ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options?.headers ?? {}) },
    ...options
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? "Falha ao comunicar com a API");
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export const api = {
  token: tokenStore,
  login: async (body: { username: string; password: string }) => {
    const result = await request<{ token: string; user: AppUser; permissions: string[] }>("/auth/login", { method: "POST", body: JSON.stringify(body) });
    tokenStore.set(result.token);
    return result;
  },
  me: () => request<{ user: AppUser; permissions: string[] }>("/auth/me"),
  users: () => request<AppUser[]>("/users"),
  createUser: (body: Partial<AppUser> & { password?: string }) => request<AppUser>("/users", { method: "POST", body: JSON.stringify(body) }),
  updateUser: (id: string, body: Partial<AppUser> & { password?: string }) => request<AppUser>(`/users/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  logs: () => request<SystemLog[]>("/logs"),
  categories: () => request<ProductCategory[]>("/categories"),
  createCategory: (body: Partial<ProductCategory>) => request<ProductCategory>("/categories", { method: "POST", body: JSON.stringify(body) }),
  updateCategory: (id: string, body: Partial<ProductCategory>) => request<ProductCategory>(`/categories/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteCategory: (id: string) => request<void>(`/categories/${id}`, { method: "DELETE" }),
  searchImages: (q: string) => request<ImageSearchResult[]>(`/images/search?q=${encodeURIComponent(q)}`),
  importImage: (url: string) => request<{ imageUrl: string }>("/images/import", { method: "POST", body: JSON.stringify({ url }) }),
  uploadProductImage: (file: File, name: string) => {
    const form = new FormData();
    form.append("image", file);
    form.append("name", name);
    return request<{ imageUrl: string }>("/images/upload", { method: "POST", body: form });
  },
  products: () => request<Product[]>("/products"),
  createProduct: (body: Partial<Product>) => request<Product>("/products", { method: "POST", body: JSON.stringify(body) }),
  updateProduct: (id: string, body: Partial<Product>) => request<Product>(`/products/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteProduct: (id: string) => request<void>(`/products/${id}`, { method: "DELETE" }),
  stockMovements: () => request<StockMovement[]>("/stock"),
  stock: (body: { productId: string; type: "in" | "out" | "adjustment"; quantity: number; totalCost?: number; costPrice?: number; salePrice?: number; manufactureDate?: string; expirationDate?: string; note?: string }) =>
    request("/stock", { method: "POST", body: JSON.stringify(body) }),
  updateLot: (id: string, body: Partial<ProductLot>) => request<ProductLot>(`/lots/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  finance: () => request<FinanceEntry[]>("/finance"),
  createFinance: (body: { type: "income" | "expense" | "receivable"; description: string; amount: number; category?: string }) =>
    request<FinanceEntry>("/finance", { method: "POST", body: JSON.stringify(body) }),
  customers: (q = "") => request<Customer[]>(`/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  createCustomer: (body: Partial<Customer>) => request<Customer>("/customers", { method: "POST", body: JSON.stringify(body) }),
  updateCustomer: (id: string, body: Partial<Customer>) => request<Customer>(`/customers/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteCustomer: (id: string) => request<void>(`/customers/${id}`, { method: "DELETE" }),
  orders: () => request<Order[]>("/orders"),
  createOrder: (body: { source?: "admin" | "client_page"; saleType?: "avulso" | "cliente"; customerId?: string; customerName?: string; customerPhone?: string; customerCpf?: string; customerBirthday?: string; paymentMethod?: PaymentMethod; amountPaid?: number; useCashback?: boolean; items: Array<{ productId: string; quantity: number }> }) =>
    request<Order>("/orders", { method: "POST", body: JSON.stringify(body) }),
  updateOrderStatus: (id: string, status: "pending" | "preparing" | "ready" | "delivered" | "cancelled", removalKey?: string) =>
    request<Order>(`/orders/${id}/status`, { method: "PUT", body: JSON.stringify({ status, removalKey }) }),
  addOrderPayment: (id: string, amount: number) => request<Order>(`/orders/${id}/payments`, { method: "POST", body: JSON.stringify({ amount }) }),
  updateOrderPayment: (id: string, body: { paymentMethod?: PaymentMethod; paymentStatus?: "paid" | "partial" | "pending"; amountPaid?: number }) =>
    request<Order>(`/orders/${id}/payment`, { method: "PUT", body: JSON.stringify(body) }),
  deleteOrder: (id: string, removalKey: string) => request<void>(`/orders/${id}`, { method: "DELETE", body: JSON.stringify({ removalKey }) })
};
