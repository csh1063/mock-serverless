import { formatKr } from '../../lib/date.js';
import { supabase } from '../../lib/supabaseClient.js';

export default async function handler(req, res) {

    if (req.method !== 'POST') {
        return res.status(405).json({ message: 'Method Not Allowed' })
    }
    function createForm() {
        return {
            "name": "",
            "geometry": {
                "coordinates": [],
                "type": "LineString"
            },
            "duration": 0,
            "distance": 1776
        };
    }

    var reqData = req.body, resData = {};
    console.log('url : ' + req.url + '  ' + formatKr());
    // res.setHeader("Access-Control-Allow-Origin", "*");
    // res.setHeader("Access-Control-Allow-Headers", "X-Requested-With");

    console.log('body');
    // console.log(req);

    console.log('body name : ' + reqData.name);

    var addForm = createForm();
    addForm.name = reqData.name;
    addForm.distance = reqData.distance;
    addForm.geometry.coordinates = reqData.geometry;
    addForm.user_id = 1;

    const { data: routes, error } = await supabase
        .from('routes')
        .insert(addForm)
        .select()

    console.log('addForm', addForm);
    // routes.forEach(element => {
    //     console.log("before names: " + element.name);
    // });
    // routes.push(addForm);

    // routes.forEach(element => {
    //     console.log("after names: " + element.name);
    // });

    if (error) {
        console.log("error", error);
        return res.status(500).json({ error })
    }

    resData.result = true;
    resData.data = {
        success: true
    };
    return res.send(resData);
}