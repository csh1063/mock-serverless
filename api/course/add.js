import { formatKr } from '../../lib/date.js';

export default function handler(req, res) {

    function createForm() {
        return {
            "name": "",
            "geometry": {
                "coordinates": [],
                "type": "LineString"
            },
            "weight": 0,
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

    console.log('addForm', addForm);
    // routes.forEach(element => {
    //     console.log("before names: " + element.name);
    // });
    // routes.push(addForm);

    // routes.forEach(element => {
    //     console.log("after names: " + element.name);
    // });
    resData.result = true;
    resData.data = {
        success: true
    };
    res.send(resData);
}