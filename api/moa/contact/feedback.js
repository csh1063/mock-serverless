import { supabase } from '#lib/supabaseClient';

export default async function handler(req, res) {

    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    const { type, content, app_version, build_number, device_model, os_version, locale } = req.body;

    if (!type || !content) {
        return res.status(400).json({ message: 'type and content are required' });
    }

    const form = {
        type,
        content,
        app_version,
        build_number,
        device_model,
        os_version,
        locale
    };

    const { error } = await supabase
        .from('feedback')
        .insert(form);

    if (error) {
        console.log('error', error);
        return res.status(500).json({ error });
    }

    return res.status(200).json({ result: true });
}