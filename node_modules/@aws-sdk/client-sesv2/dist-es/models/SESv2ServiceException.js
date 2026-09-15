import { ServiceException as __ServiceException, } from "@smithy/core/client";
export { __ServiceException };
export class SESv2ServiceException extends __ServiceException {
    constructor(options) {
        super(options);
        Object.setPrototypeOf(this, SESv2ServiceException.prototype);
    }
}
