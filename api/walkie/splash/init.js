import { formatKr } from '#lib/date';

export default function handler(req, res) {
    var reqData = req.body, resData = {};
    console.log('url : ' + req.url + '  ' + formatKr());
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "X-Requested-With");

    // console.log('values.randomImage(), ' + values.randomImage());
    resData.result = true;
    resData.data = {
        message: "welcome",
        // imageUrl: values.randomImage()
    };
    res.send(resData);

    // //GET
    // const { name, age } = req.query;
    // console.log(name, age); // "Alice", "30"

    // //POST
    // let body = {};
    // if (req.body) {
    //     try {
    //         body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    //     } catch (e) {
    //         body = {};
    //     }
    // }

    // console.log(body);


}
