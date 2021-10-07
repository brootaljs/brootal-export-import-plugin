Cascade Initialization example:

Something.js

```
import { use } from '@brootal/core';
import importExport from "@brootal/export-import-plugin";

class Something extends Service {
    constructor(item) {
        super(item);
    }

    ...
    
    static app = app;
    static exportType = "zip";
    static exportWith = [
        { model: "SomethingDependent", foreignField: "parentId" }
    ];
}

use(Something, importExport());

export default Something;
```

Something.remote.js

```
import { Remote } from '@brootal/core';
import { ieRemote } from "@brootal/export-import-plugin";

export default {
    ...Remote,
    ...ieRemote
}
```

Service SomethingDeependent must have defined custom static export/import methods or default, obitained from @brootal/export-import-plugin
