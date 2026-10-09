// Packing Management: check availability -> pack -> deliver ( or hand over to dispatch )
const { Order, OrderItem, Vendor, User, Role } = require('../models');
const { logActivity, sendNotification, addHistory } = require('../utils/audit');
const { toId, like, nowStr, addDateRange, sumBy, uniq } = require('../utils/helpers');
const {
  loadOrderRefs, loadItemsByOrder, loadProductsFor, resolveIdsByIdOrName, idsMatching, isActive,
} = require('../utils/queries');
const { findOrder } = require('./order.controller');

// Sets produced / dispatched / delivered quantity = ordered quantity for every line
async function fillItemQuantities(orderId, fields) {
  const items = await OrderItem.rows({ order_id: orderId }, { select: 'id quantity' });
  if (!items.length) return;
  await OrderItem.bulkWrite(
    items.map((it) => ({
      updateOne: {
        filter: { id: it.id },
        update: { $set: Object.fromEntries(fields.map((f) => [f, it.quantity])) },
      },
    }))
  );
}

async function markDelivered(order, user) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleTimeString('en-IN', { hour12: true });
  const stamp = nowStr(now);

  await Order.updateOne(
    { id: order.id },
    {
      $set: {
        order_status: 'DELIVERED', delivery_status: 'DELIVERED', packing_status: 'PACKED',
        delivered_at: stamp, delivered_by_id: user.id, delivered_by_name: user.name, updated_at: stamp,
      },
    }
  );
  await addHistory(order.id, 'Order Delivered', order.order_status, 'DELIVERED', `Order Delivered by ${user.name} on ${dateStr} at ${timeStr}`, user.id);

  return {
    message: 'Order marked as Delivered successfully!',
    order_status: 'DELIVERED',
    delivered_by_name: user.name,
    delivered_at: `${dateStr} ${timeStr}`,
  };
}

// Sales persons having the role OR owning an order in the given statuses
async function filterOptionLists(statuses) {
  const [salesRole, activeOrders] = await Promise.all([
    Role.row({ slug: 'sales_person' }),
    Order.rows({ order_status: { $in: statuses } }, { select: 'sales_person_id vendor_id' }),
  ]);
  const [users, vendors] = await Promise.all([
    User.rows(
      { $or: [{ role_id: salesRole ? salesRole.id : -1 }, { id: { $in: uniq(activeOrders.map((o) => o.sales_person_id)) } }] },
      { select: 'id name', sort: { name: 1 } }
    ),
    Vendor.rows(
      { $or: [{ status: 'active' }, { id: { $in: uniq(activeOrders.map((o) => o.vendor_id)) } }] },
      { select: 'id company_name', sort: { company_name: 1 } }
    ),
  ]);
  return {
    salesPersons: users.map((u) => ({ id: u.id, name: u.name })),
    vendors: vendors.map((v) => ({ id: v.id, name: v.company_name })),
  };
}

// GET /api/packing/orders  ( also /api/production/orders )
exports.listOrders = async (req, res) => {
  const user = req.user;
  const canViewPacking =
    user.role_slug === 'super_admin' || user.permissions.includes('packing:view') ||
    user.permissions.includes('production:view') || user.role_slug === 'admin' || user.role_slug === 'production_team';
  if (!canViewPacking) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to access Packing Management' });
  }

  const { sales_person_id, vendor_id, startDate, endDate, date_from, date_to, search } = req.query;
  const sDate = startDate || date_from;
  const eDate = endDate || date_to;

  const and = [{ order_status: { $in: ['ACCEPTED', 'PROCESSING', 'ON_HOLD', 'NEW', 'DELIVERED', 'READY_FOR_DISPATCH'] } }];
  if (user.role_slug === 'sales_person') and.push({ sales_person_id: user.id });
  if (sDate || eDate) and.push(addDateRange({}, 'created_at', sDate, eDate));
  if (isActive(sales_person_id)) {
    and.push({ sales_person_id: { $in: await resolveIdsByIdOrName(User, 'name', sales_person_id) } });
  }
  if (isActive(vendor_id)) {
    and.push({ vendor_id: { $in: await resolveIdsByIdOrName(Vendor, 'company_name', vendor_id) } });
  }
  if (search) {
    and.push({
      $or: [{ order_number: like(search) }, { vendor_id: { $in: await idsMatching(Vendor, ['company_name'], search) } }],
    });
  }

  const rows = await Order.rows({ $and: and });

  const rank = (o) => {
    if (o.packing_status === 'PENDING_PACKING' || o.production_status === 'ASSIGNED') return 1;
    if (o.packing_status === 'PACKING_IN_PROGRESS' || o.production_status === 'IN_PRODUCTION') return 2;
    if (o.packing_status === 'PACKED' || o.production_status === 'PRODUCTION_COMPLETED') return 3;
    if (o.packing_status === 'ON_HOLD') return 4;
    if (o.order_status === 'DELIVERED') return 5;
    return 6;
  };
  rows.sort((a, b) => rank(a) - rank(b) || b.id - a.id);

  const displayPackingStatus = (o) => {
    if (o.order_status === 'DELIVERED' || o.delivery_status === 'DELIVERED') return 'DELIVERED';
    if (['HANDED_OVER_TO_DISPATCH', 'HANDED_OVER'].includes(o.packing_status)) return 'PACKED';
    if (o.packing_status != null) return o.packing_status;
    if (o.production_status === 'PRODUCTION_COMPLETED') return 'PACKED';
    if (o.production_status === 'IN_PRODUCTION') return 'PACKING_IN_PROGRESS';
    return 'PENDING_PACKING';
  };

  const [refs, itemsMap] = await Promise.all([
    loadOrderRefs(rows, { companies: false }),
    loadItemsByOrder(rows.map((o) => o.id)),
  ]);
  const products = await loadProductsFor([...itemsMap.values()].flat(), { withBrand: true });

  const orders = rows.map((o) => {
    const items = itemsMap.get(o.id) || [];
    return {
      id: o.id, order_number: o.order_number, order_status: o.order_status, production_status: o.production_status,
      vendor_id: o.vendor_id, sales_person_id: o.sales_person_id,
      packing_status: displayPackingStatus(o),
      packing_notes: o.packing_notes,
      required_delivery_date: o.required_delivery_date, created_at: o.created_at, delivered_at: o.delivered_at,
      delivered_by_name: o.delivered_by_name, grand_total: o.grand_total,
      vendor_name: refs.vendors.get(o.vendor_id)?.company_name ?? null,
      vendor_city: refs.vendors.get(o.vendor_id)?.city ?? null,
      sales_person_name: refs.users.get(o.sales_person_id)?.name ?? null,
      item_count: items.length,
      total_qty: items.length ? sumBy(items, (i) => i.quantity) : null,
      items: items.map((i) => {
        const p = products.get(i.product_id);
        return {
          id: i.id, product_id: i.product_id, sku: i.sku, product_name: i.product_name, unit: i.unit, quantity: i.quantity,
          item_availability: i.item_availability ?? 'AVAILABLE',
          product_image: p?.image_url ?? null, item_colour: p?.item_colour ?? null,
          brand_name: p?.brand_name ?? null, category_name: p?.category_name ?? null,
        };
      }),
    };
  });

  const lists = await filterOptionLists(['ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH', 'NEW', 'ON_HOLD']);
  res.json({ orders, ...lists });
};

// Action 1: Toggle item availability ( Item Ready / Not Available )
exports.toggleItemAvailability = async (req, res) => {
  const user = req.user;
  const { item_id, availability, hold_reason } = req.body;
  const order = await findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const statusVal = availability === 'NOT_AVAILABLE' ? 'NOT_AVAILABLE' : 'AVAILABLE';
  await OrderItem.updateOne({ id: toId(item_id), order_id: order.id }, { $set: { item_availability: statusVal } });

  if (statusVal === 'NOT_AVAILABLE') {
    await Order.updateOne(
      { id: order.id },
      { $set: { packing_status: 'ON_HOLD', packing_notes: hold_reason || 'Item shortage reported during packing check', updated_at: nowStr() } }
    );
    await addHistory(order.id, 'Packing On Hold', order.packing_status || 'PENDING_PACKING', 'ON_HOLD', `Item shortage: ${hold_reason || 'Reported not available by packing team'}. Admin notified.`, user.id);
    await logActivity(user.id, 'PACKING_ON_HOLD', 'order', order.order_number, `${user.name} marked ${order.order_number} ON HOLD due to item unavailability`);
    await sendNotification(null, 'admin', 'Packing Order On Hold', `Order ${order.order_number} put on hold due to missing item stock`, 'warning', order.id);

    return res.json({ message: 'Item marked Not Available. Order is now ON HOLD and Admin has been notified.', packing_status: 'ON_HOLD' });
  }

  const notAvailCount = await OrderItem.countDocuments({ order_id: order.id, item_availability: 'NOT_AVAILABLE' });
  if (notAvailCount === 0 && order.packing_status === 'ON_HOLD') {
    await Order.updateOne({ id: order.id }, { $set: { packing_status: 'PENDING_PACKING', packing_notes: null } });
  }
  return res.json({ message: 'Item marked Available and ready for packing.' });
};

// Action 2: Start packing
exports.startPacking = async (req, res) => {
  const user = req.user;
  const order = await findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  await Order.updateOne(
    { id: order.id },
    { $set: { packing_status: 'PACKING_IN_PROGRESS', order_status: 'PROCESSING', updated_at: nowStr() } }
  );
  await addHistory(order.id, 'Packing Started', order.packing_status || 'PENDING_PACKING', 'PACKING_IN_PROGRESS', `Packing team initiated picking and drum/carton packing (Logged by ${user.name})`, user.id);
  await logActivity(user.id, 'PACKING_STARTED', 'order', order.order_number, `${user.name} started packing order ${order.order_number}`);

  res.json({ message: 'Packing in progress', packing_status: 'PACKING_IN_PROGRESS' });
};

// Action 3: Complete packing
exports.completePacking = async (req, res) => {
  const user = req.user;
  const order = await findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const notAvail = await OrderItem.countDocuments({ order_id: order.id, item_availability: 'NOT_AVAILABLE' });
  if (notAvail > 0) {
    return res.status(400).json({ error: 'Cannot complete packing while one or more items are marked Not Available.' });
  }

  await fillItemQuantities(order.id, ['produced_quantity']);
  await Order.updateOne(
    { id: order.id },
    { $set: { packing_status: 'PACKED', order_status: 'PROCESSING', updated_at: nowStr() } }
  );
  await addHistory(order.id, 'Packing Completed', order.packing_status || 'PACKING_IN_PROGRESS', 'PACKED', `All ordered items packed, labeled and verified by ${user.name}. Ready for DELIVER.`, user.id);
  await logActivity(user.id, 'PACKING_COMPLETED', 'order', order.order_number, `${user.name} completed packing for ${order.order_number}`);

  res.json({ message: 'Packing completed successfully! Status is Packed. Click DELIVER to mark Delivered.', packing_status: 'PACKED' });
};

// Action 4: Direct delivery ( Packed -> DELIVER button -> Delivered )
exports.deliver = async (req, res) => {
  const user = req.user;
  const order = await findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  if (order.order_status === 'DELIVERED') return res.status(400).json({ error: 'Order is already marked as Delivered' });
  if (order.order_status === 'CANCELLED') return res.status(400).json({ error: 'Cannot deliver a cancelled order' });

  const isAuthorized =
    ['super_admin', 'admin', 'packing_team', 'production_team', 'sales_person'].includes(user.role_slug) ||
    ['packing:deliver', 'orders:deliver', 'packing:manage', 'packing:view', 'orders:view_all', 'orders:approve'].some((p) =>
      user.permissions.includes(p)
    );
  if (!isAuthorized) {
    return res.status(403).json({ error: 'Access denied: You do not have permission to mark orders as Delivered' });
  }

  await fillItemQuantities(order.id, ['produced_quantity', 'dispatched_quantity', 'delivered_quantity']);
  const payload = await markDelivered(order, user);

  await logActivity(user.id, 'ORDER_DELIVERED', 'order', order.order_number, `${user.name} marked order ${order.order_number} as Delivered`);
  await sendNotification(order.sales_person_id, null, 'Order Delivered', `Order ${order.order_number} has been Delivered!`, 'success', order.id);
  await sendNotification(null, 'admin', 'Order Delivered', `Order ${order.order_number} delivered by ${user.name}`, 'info', order.id);

  res.json(payload);
};

// Hand over to Dispatch team
exports.handoverDispatch = async (req, res) => {
  const user = req.user;
  const order = await findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  await fillItemQuantities(order.id, ['produced_quantity']);
  const now = nowStr();
  await Order.updateOne(
    { id: order.id },
    {
      $set: {
        packing_status: 'HANDED_OVER_TO_DISPATCH', production_status: 'PRODUCTION_COMPLETED',
        order_status: 'READY_FOR_DISPATCH', production_completed_at: now, updated_at: now,
      },
    }
  );
  await addHistory(order.id, 'Handed Over to Dispatch', order.packing_status || 'PACKED', 'READY_FOR_DISPATCH', 'Packed consignment handed over to logistics bay. Ready for vehicle loading.', user.id);
  await logActivity(user.id, 'PACKING_HANDOVER', 'order', order.order_number, `${user.name} handed over packed order ${order.order_number} to Dispatch`);
  await sendNotification(null, 'dispatch_team', 'Ready for Vehicle Loading', `Order ${order.order_number} packed and handed over to Dispatch bay`, 'success', order.id);

  res.json({ message: 'Order successfully handed over to Dispatch Team! Status updated to Ready for Dispatch.', packing_status: 'HANDED_OVER_TO_DISPATCH' });
};

// Backward compatible legacy routes
exports.legacyStartProduction = async (req, res) => {
  await Order.updateOne({ id: toId(req.params.id) }, { $set: { packing_status: 'PACKING_IN_PROGRESS', order_status: 'PROCESSING' } });
  res.json({ message: 'Packing started' });
};

exports.legacyMarkProductionCompleted = async (req, res) => {
  const id = toId(req.params.id);
  await fillItemQuantities(id, ['produced_quantity']);
  await Order.updateOne(
    { id },
    { $set: { packing_status: 'HANDED_OVER_TO_DISPATCH', production_status: 'PRODUCTION_COMPLETED', order_status: 'READY_FOR_DISPATCH' } }
  );
  res.json({ message: 'Handed over to Dispatch' });
};

// POST /api/orders/:id/packing-action  ( single endpoint, action in body )
exports.packingAction = async (req, res) => {
  const user = req.user;
  const canManagePacking =
    user.role_slug === 'super_admin' || user.permissions.includes('packing:manage') ||
    user.permissions.includes('production:update') || user.role_slug === 'admin' || user.role_slug === 'production_team';
  if (!canManagePacking) {
    return res.status(403).json({ error: 'Forbidden: You do not have permission to manage packing actions' });
  }

  const { action, item_id, availability, notes } = req.body;
  const order = await findOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const id = order.id;
  const now = nowStr();

  if (action === 'START_PACKING') {
    await Order.updateOne({ id }, { $set: { packing_status: 'PACKING_IN_PROGRESS', order_status: 'PROCESSING', updated_at: now } });
    await addHistory(id, 'Packing Started', order.packing_status, 'PACKING_IN_PROGRESS', 'Packing team started picking and packing finished lubricant items', user.id);
    return res.json({ message: 'Order packing in progress' });
  }

  if (action === 'ITEM_AVAILABILITY') {
    if (!item_id || !availability) {
      return res.status(400).json({ error: 'item_id and availability are required' });
    }
    await OrderItem.updateOne({ id: toId(item_id), order_id: id }, { $set: { item_availability: availability } });

    if (availability === 'NOT_AVAILABLE') {
      await Order.updateOne({ id }, { $set: { packing_status: 'ON_HOLD', order_status: 'ON_HOLD', updated_at: now } });
      await addHistory(id, 'Order On Hold', order.order_status, 'ON_HOLD', 'Item marked Not Available by Packing Team. Order placed On Hold.', user.id);
      await sendNotification(null, 'admin', 'Order On Hold - Item Unavailable', `Order ${order.order_number} marked ON HOLD by packing team: item out of stock`, 'warning', id);
    }
    return res.json({ message: `Item availability updated to ${availability}` });
  }

  if (action === 'MARK_ON_HOLD') {
    await Order.updateOne(
      { id },
      { $set: { packing_status: 'ON_HOLD', order_status: 'ON_HOLD', packing_notes: notes || 'Item not available in warehouse', updated_at: now } }
    );
    await addHistory(id, 'Order On Hold', order.order_status, 'ON_HOLD', notes || 'Placed on hold by Packing Team', user.id);
    await sendNotification(null, 'admin', 'Order Placed On Hold', `Order ${order.order_number} placed ON HOLD by packing team: ${notes || 'Stock unavailable'}`, 'warning', id);
    return res.json({ message: 'Order placed On Hold and Admin notified' });
  }

  if (action === 'PACKING_COMPLETED') {
    await fillItemQuantities(id, ['produced_quantity']);
    await Order.updateOne({ id }, { $set: { packing_status: 'PACKED', updated_at: now } });
    await addHistory(id, 'Packing Completed', order.packing_status, 'PACKED', 'Finished products packed and sealed in warehouse', user.id);
    return res.json({ message: 'Packing completed successfully' });
  }

  if (action === 'HANDOVER_DISPATCH') {
    await fillItemQuantities(id, ['produced_quantity']);
    await Order.updateOne(
      { id },
      { $set: { packing_status: 'HANDED_OVER', order_status: 'READY_FOR_DISPATCH', production_status: 'PRODUCTION_COMPLETED', updated_at: now } }
    );
    await addHistory(id, 'Handed Over to Dispatch', order.packing_status, 'READY_FOR_DISPATCH', 'Order packed and handed over to Dispatch Team. Ready for vehicle loading.', user.id);
    await sendNotification(null, 'dispatch', 'Ready for Dispatch', `Order ${order.order_number} has been packed and handed over for transport loading`, 'info', id);
    return res.json({ message: 'Order handed over to Dispatch Team successfully' });
  }

  if (action === 'DELIVER_ORDER') {
    await fillItemQuantities(id, ['produced_quantity', 'delivered_quantity']);
    const payload = await markDelivered(order, user);
    await logActivity(user.id, 'ORDER_DELIVERED', 'order', order.order_number, `${user.name} confirmed direct delivery of order ${order.order_number}`);
    await sendNotification(order.sales_person_id, null, 'Order Delivered', `Order ${order.order_number} has been Delivered!`, 'success', id);
    return res.json(payload);
  }

  res.status(400).json({ error: 'Unknown packing action' });
};

exports.filterOptionLists = filterOptionLists;
exports.fillItemQuantities = fillItemQuantities;
