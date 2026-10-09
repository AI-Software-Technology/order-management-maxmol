const { Company } = require('../models');
const { logActivity } = require('../utils/audit');
const { toId } = require('../utils/helpers');

exports.list = async (_req, res) => {
  const companies = await Company.rows({}, { sort: { id: 1 } });
  res.json({ companies });
};

exports.create = async (req, res) => {
  const { name, code, logo_url, gst_number, address, city, state, pincode, mobile, email, bank_name, account_no, ifsc_code, branch, terms } = req.body;
  if (!name || !gst_number || !code) {
    return res.status(400).json({ error: 'Company Name, Code, and GSTIN are required' });
  }
  if (await Company.exists({ code })) {
    return res.status(400).json({ error: `Company code "${code}" already exists` });
  }

  const company = await Company.insert({
    name, code, logo_url: logo_url || '', gst_number, address: address || '', city: city || '', state: state || '',
    pincode: pincode || '', mobile: mobile || '', email: email || '', bank_name: bank_name || '',
    account_no: account_no || '', ifsc_code: ifsc_code || '', branch: branch || '', terms: terms || '',
  });

  await logActivity(req.user.id, 'COMPANY_CREATED', 'company', code, `Created company ${name}`);
  res.json({ id: company.id, message: 'Company created successfully' });
};

exports.update = async (req, res) => {
  const id = toId(req.params.id);
  const { name, logo_url, gst_number, address, city, state, pincode, mobile, email, bank_name, account_no, ifsc_code, branch, terms, status } = req.body;

  await Company.updateOne(
    { id },
    { $set: { name, logo_url, gst_number, address, city, state, pincode, mobile, email, bank_name, account_no, ifsc_code, branch, terms, status: status || 'active' } }
  );

  await logActivity(req.user.id, 'COMPANY_UPDATED', 'company', req.params.id, `Updated billing company ${name}`);
  res.json({ message: 'Company updated successfully' });
};
