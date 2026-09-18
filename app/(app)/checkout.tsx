import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { formatMoney, parseMoney, percentOf, type Minor } from "@/domain/money";
import {
  percentDiscount,
  fixedDiscount,
  type DiscountSpec,
  type PricedLine,
} from "@/domain/pricing";
import type { CartLine } from "@/domain/cart";
import { MOVEMENT_LABELS } from "@/domain/inventory";
import { can, requiresDiscountApproval } from "@/domain/permissions";
import { META_KEYS } from "@/data/local";
import { useApp } from "@/state/app";
import { useCart } from "@/state/cart";
import { ScannerListener, shouldAddToCart } from "@/services/scanner";
import {
  Badge,
  Box,
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  IconButton,
  KeyValue,
  Money,
  SearchField,
  TextField,
  Txt,
  styles as primitives,
} from "@/ui/primitives";
import {
  BarcodeGlyph,
  ScanIndicator,
  Sheet,
  type ScanFeedback,
} from "@/ui/patterns";
import { Header, Page, PermissionDenied } from "@/ui/shell";
import { palette, radius, spacing, tone } from "@/ui/theme";

/**
 * THE CHECKOUT SCREEN.
 *
 * Layout rationale — this is the screen a cashier stares at for eight hours, so
 * it is arranged by frequency of use, not by logical grouping:
 *
 *   LEFT (60%)  search → scan feedback → category filter → product grid.
 *               The scan indicator sits directly under the search field because
 *               that is where the eyes already are after a scan.
 *   RIGHT (40%) cart lines → totals → payment. The total is the largest text on
 *               the screen, and the pay button is fixed to the bottom so it is
 *               always in the same place, muscle-memory reachable.
 *
 * Everything on this screen works with the network unplugged. Nothing here even
 * asks whether there is one, except for the informational sync chip in the header.
 */
export default function CheckoutScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const stacked = width < 1180;

  const app = useApp();
  const cart = useCart();
  const data = app.data;
  const branch = app.branch;
  const business = app.business;

  const allowed = can(app.subject, "sale.create");
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [discountOpen, setDiscountOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [flashLineId, setFlashLineId] = useState<string | null>(null);
  const searchRef = useRef("");

  const categories = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number }>();
    for (const product of data?.cachedProducts() ?? []) {
      if (product.status !== "active") continue;
      const key = product.categoryId ?? "uncategorised";
      const existing = map.get(key);
      if (existing) existing.count += 1;
      else
        map.set(key, { id: key, name: labelForCategory(app, key), count: 1 });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [data, app.business, app.storeKind]);

  const results = useMemo(() => {
    if (!data) return [];
    const rows = data.search(query, 120);
    return categoryId
      ? rows.filter(
          (row) => (row.product.categoryId ?? "uncategorised") === categoryId,
        )
      : rows;
  }, [data, query, categoryId, app.storeKind]);

  /* ---------------------------------------------------------------- */
  /* Scanner                                                          */
  /* ---------------------------------------------------------------- */

  const handleScan = useCallback(
    async (raw: string, source: "hid" | "camera" | "manual") => {
      const feedback = await useCart.getState().scanBarcode(raw, source);
      useApp.getState().setScanFeedback(feedback);

      if (feedback.phase === "success" && feedback.code) {
        // The scanner typed into whatever had focus. If that was our search box,
        // clear it — otherwise the next search starts with a barcode in it.
        if (searchRef.current === feedback.code) {
          setQuery("");
          searchRef.current = "";
        }
        const line = useCart.getState().cart?.lines.slice(-1)[0];
        if (line) setFlashLineId(line.id);
      } else if (feedback.phase === "unknown" && feedback.code) {
        setUnknownCode(feedback.code);
      }

      if (
        !shouldAddToCart({ duplicate: false } as never) &&
        feedback.phase === "success"
      ) {
        // Debounced duplicates are reported but never added twice.
        useApp
          .getState()
          .setScanFeedback({
            ...feedback,
            phase: "duplicate",
            message: "Already scanned — quantity unchanged",
          });
      }
    },
    [],
  );

  useEffect(() => {
    const listener = new ScannerListener({
      onScan: (event) => {
        void handleScan(
          event.analysis.payload || event.analysis.value,
          event.source,
        );
      },
      /**
       * Do not steal keystrokes from a text input until the run is clearly
       * machine-length. A cashier searching for "tomato" at speed must not have
       * their typing swallowed by the global listener.
       */
      shouldCapture: ({ bufferLength, target }) => {
        const tag = (
          target as { tagName?: string } | null
        )?.tagName?.toUpperCase();
        const isTextField =
          tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
        if (isTextField) return bufferLength >= 6;
        return true;
      },
    });
    listener.start();
    return () => listener.stop();
  }, [handleScan]);

  const onSearchChange = useCallback((value: string) => {
    setQuery(value);
    searchRef.current = value;
  }, []);

  /* ---------------------------------------------------------------- */
  /* Actions                                                          */
  /* ---------------------------------------------------------------- */

  const total = cart.priced?.totals.total ?? (0 as Minor);
  const change = cart.plan()?.change ?? (0 as Minor);
  const outstanding = cart.plan()?.outstanding ?? total;
  const lineCount = cart.cart?.lines.length ?? 0;

  const completeSale = async () => {
    const result = await cart.completeSale();
    if (!result.ok) {
      app.pushToast({
        message: "Sale not completed",
        detail: result.error ?? undefined,
        toneName: "danger",
      });
      return;
    }
    setPaymentOpen(false);
    useApp
      .getState()
      .setScanFeedback({
        phase: "idle",
        message: "Ready — scan an item to begin",
        code: null,
        at: Date.now(),
      });
    app.pushToast({
      message: `Sale complete · ${result.receiptNumber}`,
      detail:
        result.warnings.length > 0
          ? result.warnings[0]
          : "Saved on this device and queued for the cloud.",
      toneName: result.warnings.length > 0 ? "warning" : "accent",
      durationMs: 6000,
      action: { label: "Change", onPress: () => setPaymentOpen(true) },
    });
  };

  if (!allowed) return <PermissionDenied what="checkout" />;

  return (
    <View style={styles.root}>
      <Header
        title="Checkout"
        subtitle={`${lineCount} line${lineCount === 1 ? "" : "s"} · ${branch?.name ?? ""}`}
        actions={
          <Box row gap={spacing.sm}>
            <Button
              label="Hold"
              size="sm"
              variant="secondary"
              icon="pause"
              disabled={lineCount === 0}
              onPress={() => void cart.holdSale("")}
            />
            <Button
              label="Held"
              size="sm"
              variant="ghost"
              icon="format-list-bulleted"
              onPress={() => router.push("/(app)/held" as never)}
            />
          </Box>
        }
      />

      <View style={[styles.body, stacked && styles.bodyStacked]}>
        {/* ------------------------- Catalog ------------------------- */}
        <View style={styles.catalog}>
          <Box padding={spacing.lg} gap={spacing.md}>
            <Box row gap={spacing.md}>
              <SearchField
                value={query}
                onChangeText={onSearchChange}
                placeholder="Scan a barcode, or search name / SKU"
                autoFocus
                style={primitives.flex}
              />
              <Button
                label="Enter code"
                variant="subtle"
                icon="barcode"
                onPress={() => {
                  const code = query.trim();
                  if (code) void handleScan(code, "manual");
                }}
                disabled={query.trim().length === 0}
              />
            </Box>

            <ScanIndicator feedback={app.scanFeedback} />

            <Box row gap={spacing.sm} style={styles.chipRow}>
              <Chip
                label="All"
                selected={categoryId === null}
                onPress={() => setCategoryId(null)}
                icon="shape-outline"
              />
              {categories.map((category) => (
                <Chip
                  key={category.id}
                  label={category.name}
                  badge={category.count}
                  selected={categoryId === category.id}
                  onPress={() =>
                    setCategoryId(
                      categoryId === category.id ? null : category.id,
                    )
                  }
                />
              ))}
            </Box>
          </Box>

          <Divider />

          <View style={styles.gridWrap}>
            <ScrollView
              style={styles.productScroll}
              contentContainerStyle={styles.productScrollContent}
              showsVerticalScrollIndicator={false}
            >
              {results.length === 0 ? (
                <EmptyState
                  icon="package-variant-closed"
                  title={
                    query ? `Nothing matches “${query}”` : "No products yet"
                  }
                  message={
                    query
                      ? "Check the spelling, search by SKU, or scan the item. You can also create the product from this screen."
                      : "Add products to start selling, or import a CSV from the Products screen."
                  }
                  action={
                    <Button
                      label="Go to Products"
                      variant="secondary"
                      icon="package-variant-plus"
                      onPress={() => router.push("/(app)/products" as never)}
                    />
                  }
                />
              ) : (
                <Box row gap={spacing.sm} style={styles.grid}>
                  {results.map(({ product, stock }) => {
                    const out = stock <= 0;
                    const low =
                      !out &&
                      product.reorderLevel > 0 &&
                      stock <= product.reorderLevel;
                    return (
                      <Pressable
                        key={product.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Add ${product.name}`}
                        onPress={() => {
                          useCart.getState().addProduct(product, 1, false);
                          useApp.getState().setScanFeedback({
                            phase: "success",
                            message: product.name,
                            code: product.sku,
                            at: Date.now(),
                          });
                        }}
                        style={({ pressed }) => [
                          styles.tile,
                          pressed ? styles.tilePressed : null,
                        ]}
                      >
                        <Box row style={styles.tileTop}>
                          <Txt
                            variant="caption"
                            color={palette.textFaint}
                            numberOfLines={1}
                            style={primitives.flex}
                          >
                            {product.sku}
                          </Txt>
                          {out ? (
                            <Badge label="Out" toneName="danger" compact />
                          ) : low ? (
                            <Badge
                              label={`Low ${formatStock(stock)}`}
                              toneName="warning"
                              compact
                            />
                          ) : (
                            <Txt variant="caption" color={palette.textFaint}>
                              {formatStock(stock)}
                            </Txt>
                          )}
                        </Box>
                        <Txt
                          variant="bodyStrong"
                          numberOfLines={2}
                          style={styles.tileName}
                        >
                          {product.name}
                        </Txt>
                        <Txt
                          variant="caption"
                          color={palette.textFaint}
                          numberOfLines={1}
                        >
                          {product.brand ?? product.unit}
                        </Txt>
                        <Box row style={styles.tileBottom}>
                          <Money
                            value={product.sellingPrice}
                            variant="moneySm"
                            color={out ? palette.textMuted : palette.accent}
                          />
                          <BarcodeGlyph value={product.sku} height={16} />
                        </Box>
                      </Pressable>
                    );
                  })}
                </Box>
              )}
            </ScrollView>
          </View>
        </View>

        {/* --------------------------- Cart -------------------------- */}
        <View style={styles.cartPane}>
          <Box padding={spacing.lg} gap={spacing.md} style={styles.cartHeader}>
            <Box row style={styles.cartTitleRow}>
              <Box>
                <Txt variant="overline" color={palette.textMuted}>
                  CURRENT SALE
                </Txt>
                <Txt variant="caption" color={palette.textFaint}>
                  {cart.cart?.id.slice(-6).toUpperCase() ?? "—"}
                </Txt>
              </Box>
              <Box row gap={spacing.xs}>
                <IconButton
                  icon="percent"
                  label="Apply discount"
                  disabled={lineCount === 0}
                  onPress={() => setDiscountOpen(true)}
                />
                <IconButton
                  icon="delete-sweep-outline"
                  label="Clear cart"
                  toneName="danger"
                  disabled={lineCount === 0}
                  onPress={() => cart.discardSale()}
                />
              </Box>
            </Box>
          </Box>

          <Divider />

          <View style={styles.cartLines}>
            {lineCount === 0 ? (
              <EmptyState
                icon="barcode-scan"
                title="Ready when you are"
                message="Scan an item with the USB or Bluetooth scanner, search on the left, or tap a product to add it."
                compact
              />
            ) : (
              // Iterate the PRICED lines, not the raw cart lines: the row shows
              // the discount share the pricing engine assigned, and that value
              // does not exist until the cart has been priced.
              (cart.priced?.lines ?? []).map((priced) => {
                const source = cart.cart?.lines.find(
                  (candidate) => candidate.id === priced.id,
                );
                return (
                  <CartLineRow
                    key={priced.id}
                    line={mergeCheckoutLine(priced, source)}
                    highlighted={flashLineId === priced.id}
                    onClearHighlight={() => setFlashLineId(null)}
                    onQuantity={(quantity) =>
                      useCart.getState().setQuantity(priced.id, quantity)
                    }
                    onRemove={() => useCart.getState().removeLine(priced.id)}
                    onDiscount={(discount) =>
                      useCart.getState().setLineDiscount(priced.id, discount)
                    }
                  />
                );
              })
            )}
          </View>

          <Divider />

          {/* ------------------------- Totals ------------------------- */}
          <Box padding={spacing.lg} gap={spacing.sm}>
            <KeyValue
              label="Subtotal"
              value={
                cart.priced
                  ? formatMoney(cart.priced.totals.subtotal, { compact: true })
                  : "—"
              }
              mono
            />
            {cart.priced && cart.priced.totals.discountTotal > 0 ? (
              <KeyValue
                label="Discount"
                value={`−${formatMoney(cart.priced.totals.discountTotal, { compact: true })}`}
                toneName="warning"
                mono
              />
            ) : null}
            {business?.settings.taxInclusive ? (
              <KeyValue
                label="Includes VAT"
                value={
                  cart.priced
                    ? formatMoney(cart.priced.totals.taxTotal, {
                        compact: true,
                      })
                    : "—"
                }
                mono
              />
            ) : (
              <KeyValue
                label="VAT"
                value={
                  cart.priced
                    ? formatMoney(cart.priced.totals.taxTotal, {
                        compact: true,
                      })
                    : "—"
                }
                mono
              />
            )}
            <Divider style={{ marginVertical: spacing.xs }} />
            <Box row style={styles.totalRow}>
              <Txt variant="overline" color={palette.textMuted}>
                TOTAL DUE
              </Txt>
              <Money value={total} variant="moneyXl" color={palette.accent} />
            </Box>
            {change > 0 ? (
              <Box row style={styles.totalRow}>
                <Txt variant="label" color={palette.textSecondary}>
                  Change due
                </Txt>
                <Money value={change} variant="money" color={palette.warning} />
              </Box>
            ) : null}
          </Box>

          <View style={styles.payBar}>
            <Button
              label={
                lineCount === 0
                  ? "Add items to pay"
                  : `Pay ${formatMoney(total, { compact: true })}`
              }
              variant="primary"
              size="lg"
              icon="cash-register"
              fullWidth
              disabled={lineCount === 0}
              onPress={() => setPaymentOpen(true)}
            />
          </View>
        </View>
      </View>

      {/* ------------------------- Sheets ------------------------- */}
      <DiscountSheet
        visible={discountOpen}
        onClose={() => setDiscountOpen(false)}
      />
      <PaymentSheet
        visible={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        onComplete={() => void completeSale()}
      />

      <Sheet
        visible={unknownCode !== null}
        title="Barcode not found"
        subtitle={unknownCode ?? ""}
        onClose={() => setUnknownCode(null)}
        width={520}
        footer={
          <>
            <Button
              label="Search instead"
              variant="secondary"
              icon="magnify"
              onPress={() => {
                setQuery(unknownCode ?? "");
                setUnknownCode(null);
              }}
            />
            <Button
              label="Create product"
              variant="primary"
              icon="package-variant-plus"
              onPress={() => {
                setUnknownCode(null);
                router.push("/(app)/products" as never);
              }}
            />
          </>
        }
      >
        <Box gap={spacing.md}>
          <Txt variant="body" color={palette.textSecondary}>
            Nothing in the local catalog carries this code. That is normal for a
            new delivery — you have three ways forward, and all of them work
            offline.
          </Txt>
          <Box row gap={spacing.md}>
            <BarcodeGlyph
              value={unknownCode ?? ""}
              height={30}
              color={palette.warning}
            />
            <Txt variant="mono" color={palette.warning}>
              {unknownCode}
            </Txt>
          </Box>
          <Box gap={spacing.sm}>
            <Hint
              icon="magnify"
              text="Search for the product by name or SKU and assign this barcode to it."
            />
            <Hint
              icon="package-variant-plus"
              text="Create the product now, with this barcode attached."
            />
            <Hint
              icon="clipboard-text-outline"
              text="Type a short numeric in-store label if the shelf label has one."
            />
          </Box>
        </Box>
      </Sheet>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Cart line                                                          */
/* ------------------------------------------------------------------ */

/** Everything a cart row needs: the pricing result plus the cart-only flags. */
type CheckoutLine = PricedLine &
  Pick<CartLine, "discount" | "addedAt" | "priceOverridden" | "scanned">;

function mergeCheckoutLine(
  priced: PricedLine,
  source: CartLine | undefined,
): CheckoutLine {
  return {
    ...priced,
    discount: (source?.discount ?? priced.discount) as DiscountSpec,
    addedAt: source?.addedAt ?? priced.id,
    priceOverridden: source?.priceOverridden ?? false,
    scanned: source?.scanned ?? false,
  };
}

function CartLineRow({
  line,
  highlighted,
  onQuantity,
  onRemove,
  onDiscount,
  onClearHighlight,
}: {
  line: CheckoutLine;
  highlighted: boolean;
  onQuantity: (quantity: number) => void;
  onRemove: () => void;
  onDiscount: (discount: DiscountSpec) => void;
  onClearHighlight: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!highlighted) return undefined;
    // Brief wash so the eye can follow a scan into the cart, then fade.
    const timer = setTimeout(onClearHighlight, 900);
    return () => clearTimeout(timer);
  }, [highlighted, onClearHighlight]);

  return (
    <View
      onPointerEnter={undefined}
      style={[
        styles.cartLine,
        hovered ? { backgroundColor: palette.surfaceHover } : null,
        highlighted ? { backgroundColor: palette.accentSoft } : null,
      ]}
    >
      <Pressable
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPress={() => void 0}
        style={styles.cartLineMain}
      >
        <Box style={primitives.flex}>
          <Box row gap={spacing.xs}>
            <Txt variant="bodyStrong" numberOfLines={1} style={primitives.flex}>
              {line.name}
            </Txt>
            {line.discount.kind !== "none" ? (
              <Badge label="−disc" toneName="warning" compact />
            ) : null}
            {line.priceOverridden ? (
              <Badge label="price" toneName="violet" compact />
            ) : null}
          </Box>
          <Txt variant="caption" color={palette.textFaint}>
            {line.sku} · {formatMoney(line.unitPrice, { compact: true })} each
          </Txt>
        </Box>
      </Pressable>

      <Box row gap={spacing.xs} style={styles.qtyGroup}>
        <IconButton
          icon="minus"
          label={`Reduce ${line.name}`}
          size={30}
          onPress={() => onQuantity(line.quantity - 1)}
        />
        <View style={styles.qtyValue}>
          <Txt variant="moneySm" tabular>
            {formatStock(line.quantity)}
          </Txt>
        </View>
        <IconButton
          icon="plus"
          label={`Increase ${line.name}`}
          size={30}
          onPress={() => onQuantity(line.quantity + 1)}
        />
      </Box>

      <Box style={styles.lineTotal}>
        <Money value={line.lineTotal} variant="moneySm" />
        {(line.lineDiscount > 0 || line.cartDiscountShare > 0) && (
          <Txt variant="caption" color={palette.warning}>
            −
            {formatMoney(line.lineDiscount + line.cartDiscountShare, {
              compact: true,
            })}
          </Txt>
        )}
      </Box>

      <Box row gap={2}>
        <IconButton
          icon="percent-outline"
          label={`Discount ${line.name}`}
          size={30}
          onPress={() =>
            onDiscount(
              line.discount.kind === "none"
                ? percentDiscount(500)
                : line.discount,
            )
          }
        />
        <IconButton
          icon="close"
          label={`Remove ${line.name}`}
          size={30}
          toneName="danger"
          onPress={onRemove}
        />
      </Box>
    </View>
  );
}

/* ------------------------------------------------------------------ */
/* Discount sheet                                                     */
/* ------------------------------------------------------------------ */

function DiscountSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const app = useApp();
  const cart = useCart();
  const [mode, setMode] = useState<"percent" | "fixed">("percent");
  const [value, setValue] = useState("");

  const subtotal = cart.priced?.totals.subtotal ?? (0 as Minor);
  const parsed =
    mode === "percent"
      ? Number(value)
      : parseMoney(value, app.business?.settings.currency ?? "NGN");
  const proposedBasisPoints =
    mode === "percent"
      ? Math.round((Number(value) || 0) * 100)
      : subtotal > 0
        ? Math.round(((parsed ?? 0) / subtotal) * 10000)
        : 0;

  const approval = app.business
    ? requiresDiscountApproval({
        subject: app.subject,
        settings: app.business.settings,
        basisPoints: proposedBasisPoints,
      })
    : { required: false, approverPermission: null, reason: null };

  const quick = [500, 1000, 1500, 2000];

  const apply = () => {
    if (mode === "percent") {
      cart.setCartDiscount(
        percentDiscount(Math.round((Number(value) || 0) * 100)),
      );
    } else {
      cart.setCartDiscount(fixedDiscount((parsed ?? 0) as Minor));
    }
    onClose();
  };

  return (
    <Sheet
      visible={visible}
      title="Apply a discount"
      subtitle="Reduces the taxable base, so VAT stays correct on the receipt."
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button
            label="Clear discount"
            variant="ghost"
            onPress={() => {
              cart.setCartDiscount({ kind: "none" });
              onClose();
            }}
          />
          <Button
            label="Apply"
            variant="primary"
            disabled={!value}
            onPress={apply}
          />
        </>
      }
    >
      <Box gap={spacing.lg}>
        <Box row gap={spacing.sm}>
          <Chip
            label="Percentage"
            selected={mode === "percent"}
            onPress={() => {
              setMode("percent");
              setValue("");
            }}
            icon="percent"
          />
          <Chip
            label="Fixed amount"
            selected={mode === "fixed"}
            onPress={() => {
              setMode("fixed");
              setValue("");
            }}
            icon="cash"
          />
        </Box>

        <TextField
          label={
            mode === "percent"
              ? "Discount percent"
              : `Discount amount (${app.business?.settings.currency ?? "NGN"})`
          }
          value={value}
          onChangeText={setValue}
          placeholder={mode === "percent" ? "5" : "500.00"}
          keyboardType={mode === "percent" ? "decimal-pad" : "decimal-pad"}
          mono
          autoFocus
          hint={
            mode === "percent"
              ? "Enter 5 for 5%."
              : "Enter the amount off the whole cart."
          }
        />

        {mode === "percent" ? (
          <Box row gap={spacing.sm}>
            {quick.map((bps) => (
              <Chip
                key={bps}
                label={`${bps / 100}%`}
                onPress={() => setValue(String(bps / 100))}
              />
            ))}
          </Box>
        ) : null}

        <Card toneName={approval.required ? "warning" : "neutral"}>
          <Box gap={spacing.xs}>
            <Txt
              variant="label"
              color={approval.required ? palette.warning : palette.textMuted}
            >
              {approval.required ? "MANAGER APPROVAL REQUIRED" : "AUTHORISED"}
            </Txt>
            <Txt variant="caption" color={palette.textSecondary}>
              {approval.required
                ? `${approval.reason} The sale will be recorded with an awaiting-approval flag and the approver is logged in the audit trail.`
                : `Your role may discount up to ${(app.business?.settings.maxDiscountBasisPoints ?? 0) / 100}% without approval.`}
            </Txt>
          </Box>
        </Card>
      </Box>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/* Payment sheet                                                      */
/* ------------------------------------------------------------------ */

const PAYMENT_METHODS: Array<{
  method: "cash" | "card" | "transfer" | "digital_wallet" | "credit";
  label: string;
  icon:
    | "cash"
    | "credit-card-outline"
    | "bank-transfer"
    | "wallet-outline"
    | "account-clock-outline";
}> = [
  { method: "cash", label: "Cash", icon: "cash" },
  { method: "card", label: "Card", icon: "credit-card-outline" },
  { method: "transfer", label: "Transfer", icon: "bank-transfer" },
  { method: "digital_wallet", label: "Wallet", icon: "wallet-outline" },
  { method: "credit", label: "Credit", icon: "account-clock-outline" },
];

function PaymentSheet({
  visible,
  onClose,
  onComplete,
}: {
  visible: boolean;
  onClose: () => void;
  onComplete: () => void;
}) {
  const app = useApp();
  const cart = useCart();
  const [method, setMethod] = useState<
    "cash" | "card" | "transfer" | "digital_wallet" | "credit"
  >("cash");
  const [tendered, setTendered] = useState("");
  const [reference, setReference] = useState("");

  const currency = app.business?.settings.currency ?? "NGN";
  const total = cart.priced?.totals.total ?? (0 as Minor);
  const tenderedMinor = (parseMoney(tendered, currency) ?? total) as Minor;
  const change = Math.max(0, tenderedMinor - total);

  useEffect(() => {
    if (visible) {
      setTendered("");
      setReference("");
      setMethod("cash");
      cart.clearPayments();
      // Default the cash tender to the exact total, which is the common case.
      cart.addPayment({
        method: "cash",
        amount: total,
        requiresAuthorization: false,
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }
  }, [visible, total]);

  const needsReference = method !== "cash" && method !== "credit";
  const offline = !app.syncStatus.online || !app.syncStatus.cloudConfigured;

  const quickCash = [total, 100000, 200000, 500000].filter(
    (amount, index, all) => all.indexOf(amount) === index && amount >= total,
  );

  const setCash = (amount: Minor) => {
    setTendered(formatMoney(amount, { bare: true, compact: true }));
    cart.clearPayments();
    cart.addPayment({ method: "cash", amount });
  };

  const setChosenMethod = (next: typeof method) => {
    setMethod(next);
    cart.clearPayments();
    if (next === "cash") {
      cart.addPayment({
        method: "cash",
        amount: tendered ? tenderedMinor : total,
        requiresAuthorization: false,
      });
    } else if (next === "credit") {
      cart.addPayment({
        method: "credit",
        amount: total,
        requiresAuthorization: false,
      });
    }
  };

  const confirm = () => {
    if (method === "cash") {
      cart.clearPayments();
      cart.addPayment({ method: "cash", amount: tenderedMinor });
    } else if (method === "credit") {
      cart.clearPayments();
      cart.addPayment({
        method: "credit",
        amount: total,
        requiresAuthorization: false,
      });
    } else {
      cart.clearPayments();
      cart.addPayment({
        method,
        amount: total,
        // A reference is what makes an externally authorised payment real. With
        // no reference and no connection, this is recorded as PENDING, never
        // as successful (PRD §12, §47).
        reference: reference.trim() || null,
        requiresAuthorization: true,
        provider: null,
      });
    }
    onComplete();
  };

  return (
    <Sheet
      visible={visible}
      title="Take payment"
      subtitle={`${formatMoney(total, { currency })} due`}
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button label="Cancel" variant="ghost" onPress={onClose} />
          <Button
            label={`Complete sale · ${formatMoney(total, { currency, compact: true })}`}
            variant="primary"
            size="md"
            icon="check-bold"
            loading={cart.committing}
            onPress={confirm}
          />
        </>
      }
    >
      <Box gap={spacing.lg}>
        <Box row gap={spacing.sm} style={styles.chipRow}>
          {PAYMENT_METHODS.map((option) => (
            <Chip
              key={option.method}
              label={option.label}
              icon={option.icon}
              selected={method === option.method}
              onPress={() => setChosenMethod(option.method)}
            />
          ))}
        </Box>

        {method === "cash" ? (
          <Box gap={spacing.md}>
            <TextField
              label="Cash received"
              value={tendered}
              onChangeText={(value) => {
                setTendered(value);
              }}
              placeholder={formatMoney(total, { bare: true })}
              keyboardType="decimal-pad"
              mono
              autoFocus
              suffix={
                <Button
                  label="Exact"
                  variant="subtle"
                  size="sm"
                  onPress={() => setCash(total)}
                />
              }
              hint={`Change due: ${formatMoney(change, { currency })}`}
            />
            <Box row gap={spacing.sm}>
              {quickCash.map((amount) => (
                <Chip
                  key={amount}
                  label={formatMoney(amount, { currency, compact: true })}
                  onPress={() => setCash(amount)}
                />
              ))}
            </Box>
          </Box>
        ) : null}

        {needsReference ? (
          <Box gap={spacing.md}>
            <TextField
              label={
                method === "card"
                  ? "Terminal RRN / approval code"
                  : "Transfer reference"
              }
              value={reference}
              onChangeText={setReference}
              placeholder="e.g. 000123456789"
              mono
              autoFocus
              hint={
                offline
                  ? "With no connection to the provider this payment will be recorded as PENDING until the reference is confirmed. It will not be counted as collected."
                  : "Enter the reference from the terminal or bank alert to mark this payment successful."
              }
            />
            {offline ? (
              <Card toneName="warning">
                <Box gap={spacing.xs}>
                  <Txt variant="label" color={palette.warning}>
                    UNCONFIRMED PAYMENT
                  </Txt>
                  <Txt variant="caption" color={palette.textSecondary}>
                    The sale still completes and the receipt still prints. The
                    payment sits in{" "}
                    <Txt variant="caption" color={palette.text}>
                      pending
                    </Txt>{" "}
                    and appears in Reports until someone confirms it — POSA will
                    never pretend an unconfirmed card payment succeeded.
                  </Txt>
                </Box>
              </Card>
            ) : null}
          </Box>
        ) : null}

        {method === "credit" ? (
          <Card toneName={cart.cart?.customerId ? "violet" : "warning"}>
            <Box gap={spacing.xs}>
              <Txt
                variant="label"
                color={cart.cart?.customerId ? palette.violet : palette.warning}
              >
                {cart.cart?.customerId ? "ON ACCOUNT" : "NO CUSTOMER ATTACHED"}
              </Txt>
              <Txt variant="caption" color={palette.textSecondary}>
                {cart.cart?.customerId
                  ? "The balance is added to the customer account and tracked as a receivable."
                  : "Attach a customer before selling on credit, or the debt has no name attached to it."}
              </Txt>
            </Box>
          </Card>
        ) : null}

        <Divider />

        <Box gap={spacing.xs}>
          <KeyValue
            label="Sale total"
            value={formatMoney(total, { currency })}
            mono
          />
          <KeyValue
            label="Change due"
            value={formatMoney(change, { currency })}
            mono
            toneName={change > 0 ? "warning" : undefined}
          />
          <KeyValue
            label="Recorded on this device"
            value={
              app.syncStatus.cloudConfigured
                ? "Yes — queued for cloud"
                : "Yes — local only"
            }
            emphasis
          />
        </Box>
      </Box>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function Hint({
  icon,
  text,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  text: string;
}) {
  return (
    <Box row gap={spacing.sm}>
      <MaterialCommunityIcons name={icon} size={15} color={palette.textMuted} />
      <Txt
        variant="caption"
        color={palette.textSecondary}
        style={primitives.flex}
      >
        {text}
      </Txt>
    </Box>
  );
}

function formatStock(quantity: number): string {
  return Number.isInteger(quantity)
    ? String(quantity)
    : quantity.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function labelForCategory(
  app: ReturnType<typeof useApp.getState>,
  categoryId: string,
): string {
  if (categoryId === "uncategorised") return "Uncategorised";
  void app;
  return "Category";
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg },
  body: { flex: 1, flexDirection: "row", minHeight: 0 },
  bodyStacked: { flexDirection: "column" },
  catalog: {
    flex: 3,
    minWidth: 0,
    borderRightWidth: 1,
    borderRightColor: palette.border,
  },
  cartPane: {
    flex: 2,
    minWidth: 340,
    maxWidth: 480,
    backgroundColor: palette.surface,
    flexDirection: "column",
  },
  cartHeader: { backgroundColor: palette.surface },
  cartTitleRow: { justifyContent: "space-between" },
  chipRow: { flexWrap: "wrap" },
  gridWrap: { flex: 1, minHeight: 200 },
  productScroll: { flex: 1, minHeight: 0 },
  productScrollContent: { flexGrow: 1 },
  grid: { flexWrap: "wrap", padding: spacing.lg, gap: spacing.sm },
  tile: {
    width: 168,
    minHeight: 116,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.surface,
    padding: spacing.md,
    justifyContent: "space-between",
    gap: spacing.xs,
  },
  tilePressed: {
    borderColor: palette.accentBorder,
    backgroundColor: palette.accentSoft,
  },
  tileTop: { justifyContent: "space-between" },
  tileName: { minHeight: 38 },
  tileBottom: { justifyContent: "space-between", alignItems: "flex-end" },
  cartLines: { flex: 1, minHeight: 80 },
  cartLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  cartLineMain: { flex: 1, minWidth: 0 },
  qtyGroup: { alignItems: "center" },
  qtyValue: {
    minWidth: 40,
    height: 30,
    borderRadius: radius.sm,
    backgroundColor: palette.surfaceRaised,
    alignItems: "center",
    justifyContent: "center",
  },
  lineTotal: { minWidth: 82, alignItems: "flex-end" },
  totalRow: { justifyContent: "space-between", alignItems: "baseline" },
  payBar: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: palette.border,
    backgroundColor: palette.surfaceRaised,
  },
});
